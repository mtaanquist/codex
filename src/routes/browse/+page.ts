import { redirect } from '@sveltejs/kit';
import { BROWSE_ADULT_KEY, withRememberedAdult } from '#lib/browse';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url, data }) => {
	if (typeof window !== 'undefined') {
		let remembered = false;
		try {
			remembered = localStorage.getItem(BROWSE_ADULT_KEY) === 'show';
		} catch {
			// Storage can be blocked; nothing is remembered then.
		}
		const target = withRememberedAdult(url, remembered);
		if (target) redirect(307, target);
	}
	return data;
};
