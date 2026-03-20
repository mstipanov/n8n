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

	// Strip base path for N8N_PATH deployments
	let pathname = url.pathname;
	if (window.BASE_PATH && pathname.startsWith(window.BASE_PATH)) {
		pathname = pathname.substring(window.BASE_PATH.length);
		// Ensure pathname starts with /
		if (!pathname.startsWith('/')) {
			pathname = '/' + pathname;
		}
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
