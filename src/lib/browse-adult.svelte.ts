import { resolve } from '$app/paths';
import type { ResolvedPathname } from '$app/types';
import { BROWSE_ADULT_KEY } from './browse.ts';
import { withQuery } from './href.ts';

// The reader's remembered "Include adult content" choice (see BROWSE_ADULT_KEY).
// Read from storage each time, since another tab may have changed it.
export function browseAdultRemembered(): boolean {
	try {
		return localStorage.getItem(BROWSE_ADULT_KEY) === 'show';
	} catch {
		// Storage can be blocked; nothing is remembered then.
		return false;
	}
}

// The same choice for links to Browse, so they point at adult=show from the
// start and a preload or click never fetches the page without it. False on
// the server and until the root layout reads storage after mounting, so the
// first render matches the server's.
export const browseAdult = $state<{ remembered: boolean }>({ remembered: false });

// The plain Browse page, with adult work when the reader chose it.
export function browseHomeHref(): ResolvedPathname {
	return withQuery(resolve('/browse'), { adult: browseAdult.remembered ? 'show' : null });
}

export function syncBrowseAdult() {
	browseAdult.remembered = browseAdultRemembered();
}

export function rememberBrowseAdult(show: boolean) {
	try {
		if (show) localStorage.setItem(BROWSE_ADULT_KEY, 'show');
		else localStorage.removeItem(BROWSE_ADULT_KEY);
	} catch {
		// Nothing to remember it in.
	}
	browseAdult.remembered = show;
}
