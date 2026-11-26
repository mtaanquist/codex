import { redirect } from '@sveltejs/kit';
import { withRememberedAdult } from '#lib/browse';
import { browseAdultRemembered } from '#lib/browse-adult.svelte';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url, data }) => {
	if (typeof window !== 'undefined') {
		// The root layout rewrites navigations inside the app before they load;
		// this catches the rest, such as going back to an older entry.
		const target = withRememberedAdult(url, browseAdultRemembered());
		if (target) redirect(307, target);
	}
	return data;
};
