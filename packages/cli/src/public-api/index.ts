import { Logger } from '@n8n/backend-common';
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
		// Fallback logging in case Logger fails
		console.error(`[Public API Debug FALLBACK] Swagger middleware called: ${req.method} ${req.originalUrl}, path: ${req.path}`);

		const logger = Container.get(Logger);

		try {
			logger.info(`[Public API Debug] Lazy middleware called for: ${req.method} ${req.originalUrl}, path: ${req.path}`);

			if (!cachedRouter) {
				logger.info(`[Public API Debug] Initializing lazy router for version ${version}`);
			const globalConfig = Container.get(GlobalConfig);
			let n8nPath = globalConfig.path;
			// Normalize the path to ensure it starts with / and ends with /
			if (!n8nPath) {
				n8nPath = '/';
			}
			if (!n8nPath.startsWith('/')) {
				n8nPath = '/' + n8nPath;
			}
			if (n8nPath !== '/' && !n8nPath.endsWith('/')) {
				n8nPath = n8nPath + '/';
			}

			const { default: YAML } = await import('yamljs');
			const swaggerDocument = YAML.load(openApiSpecPath) as JsonObject;
			logger.info(`[Public API Debug] OpenAPI spec loaded, has paths: ${swaggerDocument.paths ? 'YES' : 'NO'}`);
			if (swaggerDocument.paths) {
				logger.info(`[Public API Debug] OpenAPI paths: ${Object.keys(swaggerDocument.paths).join(', ')}`);
			}
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
	} catch (error) {
		logger.error(`[Public API Debug] Error in lazy swagger middleware: ${(error as Error).message}`);
		next(error);
	}
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
		// Fallback logging in case Logger fails
		console.error(`[Public API Debug FALLBACK] Validator middleware called: ${req.method} ${req.originalUrl}, path: ${req.path}`);

		const logger = Container.get(Logger);
		logger.info(`[Public API Debug] Validator middleware called for: ${req.method} ${req.originalUrl}, path: ${req.path}`);

		try {
			if (!cachedRouter) {
				logger.info(`[Public API Debug] Initializing validator router for version ${version}`);
			initPromise ??= (async () => {
				logger.info(`[Public API Debug] Starting validator setup for version ${version}`);
				logger.info(`[Public API Debug] OpenAPI spec path: ${openApiSpecPath}`);
				logger.info(`[Public API Debug] Handlers directory: ${handlersDirectory}`);

				// Check if OpenAPI spec exists
				try {
					await fs.access(openApiSpecPath);
					logger.info(`[Public API Debug] OpenAPI spec exists at: ${openApiSpecPath}`);

					// Try to read and log the spec content
					try {
						const specContent = await fs.readFile(openApiSpecPath, 'utf8');
						const specLines = specContent.split('\n');
						logger.info(`[Public API Debug] OpenAPI spec first 10 lines:`);
						for (let i = 0; i < Math.min(10, specLines.length); i++) {
							logger.info(`[Public API Debug]   ${i+1}: ${specLines[i]}`);
						}

						// Check for paths section
						if (specContent.includes('paths:')) {
							logger.info(`[Public API Debug] OpenAPI spec contains 'paths:' section`);
						} else {
							logger.warn(`[Public API Debug] OpenAPI spec does NOT contain 'paths:' section`);
						}
					} catch (readError) {
						logger.warn(`[Public API Debug] Could not read OpenAPI spec: ${(readError as Error).message}`);
					}
				} catch (error) {
					logger.error(`[Public API Debug] OpenAPI spec NOT found: ${openApiSpecPath}`);
				}

				const { middleware: openApiValidatorMiddleware } = await import(
					'express-openapi-validator'
				);
				const router = express.Router();

				// DEBUG: Add a test route to see if router is working
				router.get('/test', (req, res) => {
					const logger = Container.get(Logger);
					logger.info(`[Public API Debug] Test route called: ${req.method} ${req.originalUrl}`);
					res.json({ test: 'ok', path: req.path, originalUrl: req.originalUrl });
				});

				// DEBUG: Log all requests before validator
				router.use((req, res, next) => {
					const logger = Container.get(Logger);
					logger.info(`[Public API Debug] Before validator: ${req.method} ${req.path} (req.url: ${req.url})`);
					next();
				});

				logger.info(`[Public API Debug] Setting up express-openapi-validator middleware`);

				// TEST: Create a test OpenAPI spec with inline path in /tmp
				const testSpecPath = '/tmp/test-openapi.yml';
				const testSpecContent = `openapi: 3.0.0
info:
  title: Test API
  version: 1.0.0
servers:
  - url: /v1
paths:
  /test-inline:
    get:
      x-eov-operation-id: getWorkflows  # Use existing handler
      x-eov-operation-handler: v1/handlers/workflows/workflows.handler
      responses:
        '200':
          description: Test inline path
  /workflows:
    get:
      x-eov-operation-id: getWorkflows
      x-eov-operation-handler: v1/handlers/workflows/workflows.handler
      responses:
        '200':
          description: Get workflows test
`;

				try {
					await fs.writeFile(testSpecPath, testSpecContent);
					logger.info(`[Public API Debug] Created test OpenAPI spec at: ${testSpecPath}`);
					logger.info(`[Public API Debug] Test spec content:`);
					logger.info(testSpecContent);
					logger.info(`[Public API Debug] Test spec has inline /test-inline and /workflows paths`);

					// TEST: Try to require the handler manually
					const handlerPath = path.join(handlersDirectory, 'v1', 'handlers', 'workflows', 'workflows.handler');
					logger.info(`[Public API Debug] Trying to require handler at: ${handlerPath}`);
					try {
						// Try with .js extension
						const handler = require(handlerPath + '.js');
						logger.info(`[Public API Debug] Handler required successfully!`);
						logger.info(`[Public API Debug] Handler has getWorkflows: ${'getWorkflows' in handler}`);
						logger.info(`[Public API Debug] Handler keys: ${Object.keys(handler).join(', ')}`);
					} catch (requireError) {
						logger.error(`[Public API Debug] Failed to require handler: ${(requireError as Error).message}`);
						logger.error(`[Public API Debug] Stack: ${(requireError as Error).stack}`);
					}
				} catch (writeError) {
					logger.error(`[Public API Debug] Failed to write test spec: ${(writeError as Error).message}`);
					logger.info(`[Public API Debug] Will try to use original spec instead`);
				}

				try {
					// First try with the test spec (inline paths)
					logger.info(`[Public API Debug] Trying validator with TEST spec (inline paths)...`);
					router.use(
						openApiValidatorMiddleware({
							apiSpec: testSpecPath, // Use test spec instead of real one
							operationHandlers: handlersDirectory,
							validateRequests: false, // Disable request validation for testing
							validateApiSpec: false,
							validateResponses: false,
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
							validateSecurity: false, // Disable security for testing
						}),
					);
					logger.info(`[Public API Debug] express-openapi-validator middleware setup completed with TEST spec`);
				} catch (validatorError) {
					logger.error(`[Public API Debug] Error setting up express-openapi-validator with TEST spec: ${(validatorError as Error).message}`);
					logger.error(`[Public API Debug] Stack trace: ${(validatorError as Error).stack}`);
					// Try with original spec but disable more validation
					try {
						logger.info(`[Public API Debug] Trying validator with original spec but disabled validation...`);
						router.use(
							openApiValidatorMiddleware({
								apiSpec: openApiSpecPath,
								operationHandlers: handlersDirectory,
								validateRequests: false,
								validateApiSpec: false,
								validateResponses: false,
								validateSecurity: false,
							}),
						);
						logger.info(`[Public API Debug] express-openapi-validator middleware setup completed with original spec (validation disabled)`);
					} catch (secondError) {
						logger.error(`[Public API Debug] Also failed with original spec: ${(secondError as Error).message}`);
					}
				}

				// DEBUG: Add a catch-all route to see if requests pass through validator
				router.use((req, res, next) => {
					const logger = Container.get(Logger);
					logger.info(`[Public API Debug] Catch-all route: ${req.method} ${req.originalUrl}, path: ${req.path}`);
					// Don't call next() - this is the end of the router
					res.status(404).json({ error: 'Not found in router', path: req.path });
				});

				logger.info(`[Public API Debug] Validator router initialization complete for version ${version}`);
				return router;
			})();
			cachedRouter = await initPromise;
		}

		void cachedRouter(req, res, next);
	} catch (error) {
		logger.error(`[Public API Debug] Error in lazy validator middleware: ${(error as Error).message}`);
		logger.error(`[Public API Debug] Stack trace: ${(error as Error).stack}`);
		next(error);
	}
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

	if (!globalConfig.publicApi.swaggerUiDisabled) {
		apiController.use(
			`/${version}/docs`,
			createLazySwaggerMiddleware(openApiSpecPath, publicApiEndpoint, version),
		);
	}

	apiController.get(`/${version}/openapi.yml`, (_, res) => {
		res.sendFile(openApiSpecPath);
	});

	// Debug route
	apiController.get(`/${version}/debug-test`, (_, res) => {
		res.json({ debug: 'test', timestamp: Date.now(), version, publicApiEndpoint });
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
	// Get logger instance
	const logger = Container.get(Logger);

	logger.info(`[Public API Debug] Loading public API versions, endpoint: "${publicApiEndpoint}"`);
	logger.info(`[Public API Debug] Current directory: ${__dirname}`);

	try {
		const folders = await fs.readdir(__dirname);
		logger.info(`[Public API Debug] All folders in directory: ${folders.join(', ')}`);

		const versions = folders.filter((folderName) => folderName.startsWith('v'));
		logger.info(`[Public API Debug] Version folders found: ${versions.join(', ')}`);

		if (versions.length === 0) {
			logger.warn('[Public API Debug] No version folders found! Public API will not be mounted.');
		}

		const apiRouters = versions.map((version) => {
			const openApiPath = path.join(__dirname, version, 'openapi.yml');
			logger.info(`[Public API Debug] Creating API router for version: ${version}, OpenAPI path: ${openApiPath}`);

			// Check if OpenAPI spec exists
			fs.access(openApiPath).then(() => {
				logger.info(`[Public API Debug] OpenAPI spec exists for version ${version}: ${openApiPath}`);
			}).catch(() => {
				logger.warn(`[Public API Debug] OpenAPI spec NOT found for version ${version}: ${openApiPath}`);
			});

			// Also check for handlers directory
			const handlersDir = path.join(__dirname, version, 'handlers');
			fs.access(handlersDir).then(() => {
				logger.info(`[Public API Debug] Handlers directory exists for version ${version}: ${handlersDir}`);
			}).catch(() => {
				logger.warn(`[Public API Debug] Handlers directory NOT found for version ${version}: ${handlersDir}`);
			});

			return createApiRouter(version, openApiPath, __dirname, publicApiEndpoint);
		});

		const version = versions.pop()?.charAt(1);
		const latestVersion = version ? Number(version) : 1;

		logger.info(`[Public API Debug] Total API routers created: ${apiRouters.length}, Latest version: ${latestVersion}`);
		logger.info(`[Public API Debug] Public API will be mounted at: /${publicApiEndpoint}/v${latestVersion}/...`);

		return {
			apiRouters,
			apiLatestVersion: latestVersion,
		};
	} catch (error) {
		logger.error(`[Public API Debug] Error in loadPublicApiVersions: ${(error as Error).message}`);
		logger.error(`[Public API Debug] Stack trace: ${(error as Error).stack}`);
		throw error;
	}
};

export function isApiEnabled(): boolean {
	const globalConfig = Container.get(GlobalConfig);
	const license = Container.get(License);
	const logger = Container.get(Logger);

	const publicApiDisabled = globalConfig.publicApi.disabled;
	const apiDisabledByLicense = license.isAPIDisabled();
	const isEnabled = !publicApiDisabled && !apiDisabledByLicense;

	logger.info(`[Public API Debug] Checking if API is enabled:`);
	logger.info(`[Public API Debug]   - publicApi.disabled: ${publicApiDisabled}`);
	logger.info(`[Public API Debug]   - license.isAPIDisabled(): ${apiDisabledByLicense}`);
	logger.info(`[Public API Debug]   - Result: ${isEnabled ? 'ENABLED' : 'DISABLED'}`);
	logger.info(`[Public API Debug]   - Public API endpoint path: "${globalConfig.publicApi.path}"`);

	return isEnabled;
}
