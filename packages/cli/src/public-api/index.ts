import { GlobalConfig } from '@n8n/config';
import { Container } from '@n8n/di';
import type { Router, ErrorRequestHandler, RequestHandler } from 'express';
import express from 'express';
import type { HttpError } from 'express-openapi-validator/dist/framework/types';
import fs from 'fs/promises';
import path from 'path';
import type { JsonObject } from 'swagger-ui-express';
import validator from 'validator';

import { License } from '@/license';
import { PublicApiKeyService } from '@/services/public-api-key.service';
import { UrlService } from '@/services/url.service';

function createLazySwaggerMiddleware(
	openApiSpecPath: string,
	publicApiEndpoint: string,
	version: string,
): RequestHandler {
	let cachedRouter: Router | undefined;

	return async (req, res, next) => {
		if (!cachedRouter) {
			const globalConfig = Container.get(GlobalConfig);
			const n8nPath = globalConfig.path;

			const { default: YAML } = await import('yamljs');
			const swaggerDocument = YAML.load(openApiSpecPath) as JsonObject;
			// add the server depending on the config so the user can interact with the API
			// from the Swagger UI
			swaggerDocument.server = [
				{
					url: `${Container.get(UrlService).getInstanceBaseUrl()}/${publicApiEndpoint}/${version}`,
				},
			];

			const { serveFiles, setup } = await import('swagger-ui-express');
			const swaggerThemePath = path.join(__dirname, 'swagger-theme.css');
			const swaggerThemeCss = await fs.readFile(swaggerThemePath, { encoding: 'utf-8' });

			cachedRouter = express.Router();
			cachedRouter.use(
				serveFiles(swaggerDocument),
				setup(swaggerDocument, {
					customCss: swaggerThemeCss,
					customSiteTitle: 'n8n Public API UI',
					customfavIcon: `${n8nPath}favicon.ico`,
				}),
			);
		}

		void cachedRouter(req, res, next);
	};
}

function createLazyValidatorMiddleware(
	openApiSpecPath: string,
	handlersDirectory: string,
	version: string,
): RequestHandler {
	let cachedRouter: Router | undefined;
	let initPromise: Promise<Router> | undefined;

	return async (req, res, next) => {
		if (!cachedRouter) {
			initPromise ??= (async () => {
				const { middleware: openApiValidatorMiddleware } = await import(
					'express-openapi-validator'
				);

				// express-openapi-validator uses req.originalUrl for route matching
				// and compares against routes built from servers.url + spec paths.
				// When n8n has a base path (e.g. /infobip-noc-n8n), req.originalUrl
				// is /infobip-noc-n8n/api/v1/workflows but the spec's servers.url
				// is /api/v1, so routes like /api/v1/workflows won't match.
				// Fix: load the spec with $ref resolution, then set servers.url
				// to match the actual runtime base URL (req.baseUrl).
				const $RefParser = await import('@apidevtools/json-schema-ref-parser');
				const apiSpec = (await $RefParser.bundle(openApiSpecPath)) as JsonObject;
				apiSpec.servers = [{ url: req.baseUrl }];

				const router = express.Router();
				router.use(
					openApiValidatorMiddleware({
						apiSpec,
						operationHandlers: handlersDirectory,
						validateRequests: true,
						validateApiSpec: true,
						formats: {
							email: {
								type: 'string',
								validate: (email: string) => validator.isEmail(email),
							},
							identifier: {
								type: 'string',
								validate: (identifier: string) =>
									validator.isUUID(identifier) || validator.isEmail(identifier),
							},
							jsonString: {
								validate: (data: string) => {
									try {
										JSON.parse(data);
										return true;
									} catch (e) {
										return false;
									}
								},
							},
							nanoid: {
								type: 'string',
								validate: (id: string) => {
									return /^[A-Za-z0-9]{16}$/.test(id);
								},
							},
						},
						validateSecurity: {
							handlers: {
								ApiKeyAuth: Container.get(PublicApiKeyService).getAuthMiddleware(version),
							},
						},
					}),
				);
				return router;
			})();
			cachedRouter = await initPromise;
		}

		void cachedRouter(req, res, next);
	};
}

function createApiRouter(
	version: string,
	openApiSpecPath: string,
	handlersDirectory: string,
	publicApiEndpoint: string,
): Router {
	const globalConfig = Container.get(GlobalConfig);
	const apiController = express.Router();

	// NOTE: Routes use /${version} (not /${publicApiEndpoint}/${version}) because
	// this router is already mounted at the publicApiEndpoint path in server.ts
	if (!globalConfig.publicApi.swaggerUiDisabled) {
		apiController.use(
			`/${version}/docs`,
			createLazySwaggerMiddleware(openApiSpecPath, publicApiEndpoint, version),
		);
	}

	apiController.get(`/${version}/openapi.yml`, (_, res) => {
		res.sendFile(openApiSpecPath);
	});

	// Error handler specifically for JSON parsing - must come immediately after express.json()
	const jsonParseErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
		if (error instanceof SyntaxError && 'body' in error) {
			res.status(400).json({
				message: 'Invalid JSON in request body',
			});
			return;
		}
		next(error);
	};

	apiController.use(
		`/${version}`,
		express.json(),
		jsonParseErrorHandler,
		createLazyValidatorMiddleware(openApiSpecPath, handlersDirectory, version),
	);

	apiController.use(
		(
			error: HttpError,
			_req: express.Request,
			res: express.Response,
			_next: express.NextFunction,
		) => {
			res.status(error.status || 400).json({
				message: error.message,
			});
		},
	);

	return apiController;
}

export const loadPublicApiVersions = async (
	publicApiEndpoint: string,
): Promise<{ apiRouters: express.Router[]; apiLatestVersion: number }> => {
	const folders = await fs.readdir(__dirname);
	const versions = folders.filter((folderName) => folderName.startsWith('v'));

	const apiRouters = versions.map((version) => {
		const openApiPath = path.join(__dirname, version, 'openapi.yml');
		return createApiRouter(version, openApiPath, __dirname, publicApiEndpoint);
	});

	const version = versions.pop()?.charAt(1);

	return {
		apiRouters,
		apiLatestVersion: version ? Number(version) : 1,
	};
};

export function isApiEnabled(): boolean {
	return !Container.get(GlobalConfig).publicApi.disabled && !Container.get(License).isAPIDisabled();
}
