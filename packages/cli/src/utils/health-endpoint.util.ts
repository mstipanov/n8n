import type { GlobalConfig } from '@n8n/config';

/**
 * Resolves the health endpoint path, respecting N8N_PATH configuration.
 *
 * Priority order:
 * 1. N8N_ENDPOINT_HEALTH (if explicitly set) - absolute override
 * 2. N8N_PATH + default health endpoint (if N8N_PATH is set)
 * 3. Default health endpoint (/healthz)
 *
 */
export function resolveHealthEndpointPath(globalConfig: GlobalConfig): string {
	const isHealthEndpointCustomized = process.env.N8N_ENDPOINT_HEALTH !== undefined;

	if (!isHealthEndpointCustomized && globalConfig.path && globalConfig.path !== '/') {
		// Normalize path to start with / and not end with / (except for / itself)
		let normalizedPath = globalConfig.path;
		if (!normalizedPath.startsWith('/')) {
			normalizedPath = '/' + normalizedPath;
		}
		if (normalizedPath.endsWith('/') && normalizedPath !== '/') {
			normalizedPath = normalizedPath.slice(0, -1);
		}
		return normalizedPath + globalConfig.endpoints.health;
	}

	return globalConfig.endpoints.health;
}
