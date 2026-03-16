import { inTest, inDevelopment, Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { DbConnection } from '@n8n/db';
import { OnShutdown } from '@n8n/decorators';
import { Container, Service } from '@n8n/di';
import compression from 'compression';
import express from 'express';
import { readFile } from 'fs/promises';
import type { Server } from 'http';
import isbot from 'isbot';

import config from '@/config';
import { N8N_VERSION, TEMPLATES_DIR } from '@/constants';
import { ServiceUnavailableError } from '@/errors/response-errors/service-unavailable.error';
import { ExternalHooks } from '@/external-hooks';
import { rawBodyReader, bodyParser, corsMiddleware } from '@/middlewares';
import { send, sendErrorResponse } from '@/response-helper';
import { createHandlebarsEngine } from '@/utils/handlebars.util';
import { resolveHealthEndpointPath } from '@/utils/health-endpoint.util';
import { LiveWebhooks } from '@/webhooks/live-webhooks';
import { TestWebhooks } from '@/webhooks/test-webhooks';
import { WaitingForms } from '@/webhooks/waiting-forms';
import { WaitingWebhooks } from '@/webhooks/waiting-webhooks';
import { createWebhookHandlerFor } from '@/webhooks/webhook-request-handler';

@Service()
export abstract class AbstractServer {
	protected logger: Logger;

	protected server: Server;

	readonly app: express.Application;

	protected externalHooks: ExternalHooks;

	protected globalConfig = Container.get(GlobalConfig);

	protected dbConnection = Container.get(DbConnection);

	protected sslKey: string;

	protected sslCert: string;

	protected restEndpoint: string;

	protected basePath: string;

	protected endpointForm: string;

	protected endpointFormTest: string;

	protected endpointFormWaiting: string;

	protected endpointWebhook: string;

	protected endpointWebhookTest: string;

	protected endpointWebhookWaiting: string;

	protected endpointMcp: string;

	protected endpointMcpTest: string;

	protected endpointHealth: string;

	protected webhooksEnabled = true;

	protected testWebhooksEnabled = false;

	readonly uniqueInstanceId: string;

	constructor() {
		this.app = express();

		// DEBUG: Wrap Express route registration methods to log the pattern that causes path-to-regexp errors
		const originalUse = this.app.use.bind(this.app);
		const originalAll = this.app.all.bind(this.app);
		const originalGet = this.app.get.bind(this.app);
		const originalPost = this.app.post.bind(this.app);
		const originalPut = this.app.put.bind(this.app);
		const originalDelete = this.app.delete.bind(this.app);
		const originalPatch = this.app.patch.bind(this.app);
		const wrapMethod = (name: string, original: (...args: unknown[]) => unknown) => {
			return (...args: unknown[]) => {
				const pattern = typeof args[0] === 'string' ? args[0] : undefined;
				try {
					return original(...args);
				} catch (error) {
					console.error(`[path-to-regexp DEBUG] Error in app.${name}() with pattern: "${pattern}"`);
					console.error(`[path-to-regexp DEBUG] All args:`, args.map((a) => typeof a === 'string' ? a : typeof a).join(', '));
					throw error;
				}
			};
		};
		this.app.use = wrapMethod('use', originalUse) as typeof this.app.use;
		this.app.all = wrapMethod('all', originalAll) as typeof this.app.all;
		(this.app as unknown as Record<string, unknown>).get = wrapMethod('get', originalGet);
		this.app.post = wrapMethod('post', originalPost) as typeof this.app.post;
		this.app.put = wrapMethod('put', originalPut) as typeof this.app.put;
		this.app.delete = wrapMethod('delete', originalDelete) as typeof this.app.delete;
		this.app.patch = wrapMethod('patch', originalPatch) as typeof this.app.patch;

		this.app.disable('x-powered-by');
		this.app.set('query parser', 'extended');
		this.app.engine('handlebars', createHandlebarsEngine());
		this.app.set('view engine', 'handlebars');
		this.app.set('views', TEMPLATES_DIR);

		const proxyHops = this.globalConfig.proxy_hops;
		if (proxyHops > 0) this.app.set('trust proxy', proxyHops);

		this.sslKey = this.globalConfig.ssl_key;
		this.sslCert = this.globalConfig.ssl_cert;

		const { endpoints, path } = this.globalConfig;
		this.restEndpoint = endpoints.rest;

		// Normalize base path
		let basePath = path;
		if (!basePath.startsWith('/')) {
			basePath = '/' + basePath;
		}
		if (basePath.endsWith('/') && basePath !== '/') {
			basePath = basePath.slice(0, -1);
		}
		this.basePath = basePath;

		this.endpointForm = endpoints.form;
		this.endpointFormTest = endpoints.formTest;
		this.endpointFormWaiting = endpoints.formWaiting;

		this.endpointWebhook = endpoints.webhook;
		this.endpointWebhookTest = endpoints.webhookTest;
		this.endpointWebhookWaiting = endpoints.webhookWaiting;

		this.endpointMcp = endpoints.mcp;
		this.endpointMcpTest = endpoints.mcpTest;

		this.endpointHealth = resolveHealthEndpointPath(this.globalConfig);

		this.logger = Container.get(Logger);
	}

	async configure(): Promise<void> {
		// Additional configuration in derived classes
	}

	private async setupErrorHandlers() {
		const { app } = this;

		// Augment errors sent to Sentry
		const { setupExpressErrorHandler } = await import('@sentry/node');
		setupExpressErrorHandler(app);
	}

	private setupCommonMiddlewares() {
		// Compress the response data
		this.app.use(compression());

		// Read incoming data into `rawBody`
		this.app.use(rawBodyReader);
	}

	private setupDevMiddlewares() {
		this.app.use(corsMiddleware);
	}

	protected setupPushServer() {}

	private setupHealthCheck() {
		const healthPath = this.endpointHealth;
		const readinessPath = `${healthPath}/readiness`;

		// main health check should not care about DB connections
		this.app.get(healthPath, (_req, res) => {
			res.send({ status: 'ok' });
		});

		const { connectionState } = this.dbConnection;

		this.app.get(readinessPath, (_req, res) => {
			const { connected, migrated } = connectionState;
			if (connected && migrated) {
				res.status(200).send({ status: 'ok' });
			} else {
				res.status(503).send({ status: 'error' });
			}
		});

		this.app.use((_req, res, next) => {
			if (connectionState.connected) {
				if (connectionState.migrated) next();
				else res.send('n8n is starting up. Please wait');
			} else sendErrorResponse(res, new ServiceUnavailableError('Database is not ready!'));
		});
	}

	async init(): Promise<void> {
		const { app, sslKey, sslCert } = this;
		const { protocol } = this.globalConfig;

		if (protocol === 'https' && sslKey && sslCert) {
			const https = await import('https');
			this.server = https.createServer(
				{
					key: await readFile(this.sslKey, 'utf8'),
					cert: await readFile(this.sslCert, 'utf8'),
				},
				app,
			);
		} else {
			const http = await import('http');
			this.server = http.createServer(app);
		}

		const { port, listen_address: address } = Container.get(GlobalConfig);

		this.server.on('error', (error: Error & { code: string }) => {
			if (error.code === 'EADDRINUSE') {
				// EADDRINUSE is thrown when the port is already in use
				this.logger.error(
					`n8n's port ${port} is already in use. Do you have another instance of n8n running already?`,
				);
			} else if (error.code === 'EACCES') {
				// EACCES is thrown when the process is not allowed to use the port
				// This can happen if the port is below 1024 and the process is not run as root
				// or when the port is reserved by the system, for example Windows reserves random ports
				// for NAT for Hyper-V and other virtualization software.
				this.logger.error(
					`n8n does not have permission to use port ${port}. Please run n8n with a different port.`,
				);
			} else if (error.code === 'EAFNOSUPPORT') {
				// EAFNOSUPPORT is thrown when the address is not available
				this.logger.error(
					`n8n's address '${address}' is not available. Please run n8n with a different address, provide correct address in the environment variables N8N_LISTEN_ADDRESS and/or N8N_WORKER_SERVER_ADDRESS.`,
				);
			} else {
				// Other errors are unexpected and should be logged
				this.logger.error('n8n webserver failed, exiting', {
					message: error.message,
					code: error.code,
				});
			}
			// we always exit on error, so that n8n does not run in an inconsistent state
			process.exit(1);
		});

		await new Promise<void>((resolve) => this.server.listen(port, address, () => resolve()));

		this.externalHooks = Container.get(ExternalHooks);

		this.setupHealthCheck();

		this.logger.info(`n8n ready on ${address}, port ${port}`);
	}

	async start(): Promise<void> {
		if (!inTest) {
			await this.setupErrorHandlers();
			this.setupPushServer();
		}

		this.setupCommonMiddlewares();

		// Setup webhook handlers before bodyParser, to let the Webhook node handle binary data in requests
		if (this.webhooksEnabled) {
			const liveWebhooksRequestHandler = createWebhookHandlerFor(Container.get(LiveWebhooks));
			// Register a handler for live forms
			this.app.all(`/${this.endpointForm}/*path`, liveWebhooksRequestHandler);

			// Register a handler for live webhooks
			this.app.all(`/${this.endpointWebhook}/*path`, liveWebhooksRequestHandler);

			// Register a handler for waiting forms
			this.app.all(
				`/${this.endpointFormWaiting}/:path/:suffix?`,
				createWebhookHandlerFor(Container.get(WaitingForms)),
			);

			// Register a handler for waiting webhooks
			this.app.all(
				`/${this.endpointWebhookWaiting}/:path/:suffix?`,
				createWebhookHandlerFor(Container.get(WaitingWebhooks)),
			);

			// Register a handler for live MCP servers
			this.app.all(`/${this.endpointMcp}/*path`, liveWebhooksRequestHandler);
		}

		if (this.testWebhooksEnabled) {
			const testWebhooksRequestHandler = createWebhookHandlerFor(Container.get(TestWebhooks));

			// Register a handler
			this.app.all(`/${this.endpointFormTest}/*path`, testWebhooksRequestHandler);
			this.app.all(`/${this.endpointWebhookTest}/*path`, testWebhooksRequestHandler);

			// Register a handler for test MCP servers
			this.app.all(`/${this.endpointMcpTest}/*path`, testWebhooksRequestHandler);
		}

		// Block bots from scanning the application
		const checkIfBot = isbot.spawn(['bot']);
		this.app.use((req, res, next) => {
			const userAgent = req.headers['user-agent'];
			if (userAgent && checkIfBot(userAgent)) {
				this.logger.info(`Blocked ${req.method} ${req.url} for "${userAgent}"`);
				res.status(204).end();
			} else next();
		});

		if (inDevelopment) {
			this.setupDevMiddlewares();
		}

		if (this.testWebhooksEnabled) {
			const testWebhooks = Container.get(TestWebhooks);
			// Removes a test webhook
			// TODO UM: check if this needs validation with user management.
			const path = this.basePath !== '/' ? this.basePath + `/${this.restEndpoint}/test-webhook/:id` : `/${this.restEndpoint}/test-webhook/:id`;
			this.app.delete(
				path,
				send(async (req) => await testWebhooks.cancelWebhook(req.params.id)),
			);
		}

		// Setup body parsing middleware after the webhook handlers are setup
		this.app.use(bodyParser);

		await this.configure();

		if (!inTest) {
			this.logger.info(`Version: ${N8N_VERSION}`);

			const { defaultLocale } = this.globalConfig;
			if (defaultLocale !== 'en') {
				this.logger.info(`Locale: ${defaultLocale}`);
			}

			await this.externalHooks.run('n8n.ready', [this, config]);
		}
	}

	/**
	 * Stops the HTTP(S) server from accepting new connections. Gives all
	 * connections configured amount of time to finish their work and
	 * then closes them forcefully.
	 */
	@OnShutdown()
	onShutdown(): void {
		if (!this.server) {
			return;
		}

		const { protocol } = this.globalConfig;

		this.logger.debug(`Shutting down ${protocol} server`);

		this.server.close((error) => {
			if (error) {
				this.logger.error(`Error while shutting down ${protocol} server`, { error });
			}

			this.logger.debug(`${protocol} server shut down`);
		});
	}
}
