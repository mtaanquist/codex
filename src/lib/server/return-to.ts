import type { Cookies } from '@sveltejs/kit';

// Where to send someone once they have signed in, for the one page that has
// to survive a trip through sign-in: the page where a writer allows an outside
// app, which the app opens for them. The place is remembered in a short-lived
// cookie when the sign-in redirect happens and taken back out when a session
// is created, whichever way they signed in.

export const RETURN_TO_COOKIE = 'return_to';
const MAX_AGE_SECONDS = 10 * 60;
// The longest value kept, measured as it goes into the cookie (encoded). A
// browser drops a cookie of more than about 4096 bytes without a word, and
// would then keep an older one, so the cap leaves room for the name and the
// attributes.
const MAX_ENCODED_LENGTH = 3800;

// Only this page may be returned to. A fixed list, so the cookie can never
// send anyone to another site or to an arbitrary page of this one.
const RETURNABLE_PATHS: ReadonlySet<string> = new Set(['/oauth/authorize']);

// The path and query to return to, or null when the value is not one of the
// returnable pages on this site.
export function safeReturnTo(value: string | null | undefined): string | null {
	// Encoding never makes a value shorter, so a long one is refused at once.
	if (!value || value.length > MAX_ENCODED_LENGTH) return null;
	// One leading slash only: "//host" and "/\host" are other sites to a browser.
	if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
	let url: URL;
	try {
		url = new URL(value, 'http://self.invalid');
	} catch {
		return null;
	}
	if (url.origin !== 'http://self.invalid' || !RETURNABLE_PATHS.has(url.pathname)) return null;
	const target = url.pathname + url.search;
	return encodeURIComponent(target).length > MAX_ENCODED_LENGTH ? null : target;
}

// The same, for a form posted to a returnable page: the page's address with
// the named fields of the form as its query. For a writer whose sign-in ended
// between opening the page and answering it, so that after signing in they
// are back at the page and not at the app's mercy to start again. Only the
// named fields are kept, and the page checks them again when it loads.
export function returnToForForm(
	pathname: string,
	form: FormData,
	names: readonly string[]
): string | null {
	if (!RETURNABLE_PATHS.has(pathname)) return null;
	const query = new URLSearchParams();
	for (const name of names) {
		const value = form.get(name);
		if (typeof value === 'string') query.set(name, value);
	}
	return safeReturnTo(`${pathname}?${query}`);
}

export const RETURN_TO_COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	sameSite: 'lax',
	maxAge: MAX_AGE_SECONDS
} as const;

export function isReturnablePath(pathname: string): boolean {
	return RETURNABLE_PATHS.has(pathname);
}

// The Set-Cookie value that remembers the page, for the sign-in redirect.
// When this page cannot be remembered, an older one is forgotten instead, so
// that signing in does not lead somewhere the writer has since left.
export function rememberReturnTo(cookies: Cookies, url: URL): string | null {
	const target = safeReturnTo(url.pathname + url.search);
	if (target) return cookies.serialize(RETURN_TO_COOKIE, target, RETURN_TO_COOKIE_OPTIONS);
	if (cookies.get(RETURN_TO_COOKIE) === undefined) return null;
	return cookies.serialize(RETURN_TO_COOKIE, '', { path: '/', maxAge: 0 });
}

// The same through the cookies of a response SvelteKit builds: remembers the
// target, or forgets any older one when there is none.
export function storeReturnTo(cookies: Cookies, target: string | null): void {
	if (target) cookies.set(RETURN_TO_COOKIE, target, RETURN_TO_COOKIE_OPTIONS);
	else if (cookies.get(RETURN_TO_COOKIE) !== undefined)
		cookies.delete(RETURN_TO_COOKIE, { path: '/' });
}

// Call when a session has just been created. Returns where to go, and forgets
// it, so it is used once.
export function takeReturnTo(cookies: Cookies): string | null {
	const stored = cookies.get(RETURN_TO_COOKIE);
	if (stored === undefined) return null;
	cookies.delete(RETURN_TO_COOKIE, { path: '/' });
	return safeReturnTo(stored);
}
