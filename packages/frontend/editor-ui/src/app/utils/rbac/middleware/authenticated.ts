import type { RouterMiddleware } from '@/app/types/router';
import { VIEWS } from '@/app/constants';
import type { AuthenticatedPermissionOptions } from '@/app/types/rbac';
import { isAuthenticated, shouldEnableMfa } from '@/app/utils/rbac/checks';

export const authenticatedMiddleware: RouterMiddleware<AuthenticatedPermissionOptions> = async (
	to,
	_from,
	next,
	options,
) => {
	// ensure that we are removing the already existing redirect query parameter
	// to avoid infinite redirect loops
	const url = new URL(window.location.href);
	url.searchParams.delete('redirect');

	// Get the pathname without the base path
	let pathname = url.pathname;
	const basePath = window.BASE_PATH ?? '/';

	// Remove the base path from the beginning of the pathname if present
	if (basePath !== '/') {
		// basePath has format like "/infobip-noc-n8n/" (with slashes)
		// Remove trailing slash from basePath for comparison
		const basePathWithoutTrailingSlash = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;

		// Check if pathname starts with basePath (with or without trailing slash)
		if (pathname === basePathWithoutTrailingSlash || pathname === basePath) {
			// Exact match: pathname is just the base path
			pathname = '/';
		} else if (pathname.startsWith(basePathWithoutTrailingSlash + '/')) {
			// Pathname starts with base path followed by /
			pathname = pathname.slice(basePathWithoutTrailingSlash.length);
		}
	}
	// Ensure pathname starts with /
	if (!pathname.startsWith('/')) {
		pathname = '/' + pathname;
	}

	const redirect = to.query.redirect ?? encodeURIComponent(`${pathname}${url.search}`);

	const valid = isAuthenticated(options);
	if (!valid) {
		return next({ name: VIEWS.SIGNIN, query: { redirect } });
	}

	// If MFA is not enabled, and the instance enforces MFA, redirect to personal settings
	const mfaNeeded = shouldEnableMfa();
	if (mfaNeeded) {
		if (to.name !== VIEWS.PERSONAL_SETTINGS) {
			return next({ name: VIEWS.PERSONAL_SETTINGS, query: { redirect } });
		}
		return;
	}
};
