import type { LayoutServerLoad } from './$types';
import { db } from '#lib/server/db';
import { userPreferences } from '#lib/server/preferences';
import { requestTimeZone } from '#lib/server/timezone';
import { browseEnabled } from '#lib/server/settings';

// The signed-in user's appearance, so the layout can apply the saved theme and
// accent across the app and on a fresh device. Null for guests, who keep the
// pre-paint script's per-device choice.
// timeZone is the author's clock, read by every date and time on the page
// (page.data.timeZone) so the server renders what the browser would.
// browse says whether the public Browse page is on, for the links to it in
// the public bars and footers.
export const load: LayoutServerLoad = async ({ locals, cookies }) => {
	const timeZone = requestTimeZone(cookies);
	const browse = await browseEnabled(db);
	if (!locals.user) return { appearance: null, user: null, timeZone, browse };
	const prefs = await userPreferences(db, locals.user.id);
	return {
		appearance: {
			theme: prefs.theme,
			systemLightTheme: prefs.systemLightTheme,
			systemDarkTheme: prefs.systemDarkTheme,
			accent: prefs.accent
		},
		// Drives the avatar menu in the top bars.
		user: {
			displayName: locals.user.displayName,
			email: locals.user.email,
			isAdmin: locals.user.role === 'admin',
			isModerator: locals.user.role === 'moderator'
		},
		timeZone,
		browse
	};
};
