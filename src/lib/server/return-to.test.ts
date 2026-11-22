import { describe, it, expect } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import {
	RETURN_TO_COOKIE,
	rememberReturnTo,
	returnToForForm,
	safeReturnTo,
	storeReturnTo,
	takeReturnTo
} from './return-to';

function cookieJar(initial: Record<string, string> = {}) {
	const jar = new Map(Object.entries(initial));
	const cookies = {
		get: (name: string) => jar.get(name),
		delete: (name: string) => void jar.delete(name),
		set: (name: string, value: string) => void jar.set(name, value),
		serialize: (name: string, value: string, options?: { maxAge?: number }) =>
			options?.maxAge === 0
				? `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=0`
				: `${name}=${encodeURIComponent(value)}`
	} as unknown as Cookies;
	return { jar, cookies };
}

describe('returnToForForm', () => {
	const posted = (fields: Record<string, string>) => {
		const form = new FormData();
		for (const [name, value] of Object.entries(fields)) form.set(name, value);
		return form;
	};

	it('rebuilds the consent page address from the named fields of its form', () => {
		const form = posted({
			client_id: 'abc',
			state: 'x y&z',
			permission: 'read',
			redirect_uri: 'https://app.example/cb'
		});
		expect(returnToForForm('/oauth/authorize', form, ['client_id', 'redirect_uri', 'state'])).toBe(
			'/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=x+y%26z'
		);
	});

	it('gives nothing for a form posted to any other page, or one too long to keep', () => {
		expect(returnToForForm('/account', posted({ client_id: 'abc' }), ['client_id'])).toBeNull();
		expect(
			returnToForForm('/oauth/authorize', posted({ state: 'x'.repeat(5000) }), ['state'])
		).toBeNull();
	});

	it('leaves out a file sent under a field name', () => {
		const form = new FormData();
		form.set('client_id', new Blob(['x']), 'x.txt');
		expect(returnToForForm('/oauth/authorize', form, ['client_id'])).toBe('/oauth/authorize');
	});
});

describe('safeReturnTo', () => {
	it('keeps the consent page with its query', () => {
		expect(safeReturnTo('/oauth/authorize?client_id=abc&state=x%20y')).toBe(
			'/oauth/authorize?client_id=abc&state=x%20y'
		);
	});

	it('refuses any other page of this site', () => {
		for (const value of ['/', '/account', '/oauth/token', '/oauth/authorize/extra', '/admin']) {
			expect(safeReturnTo(value)).toBeNull();
		}
	});

	it('refuses anything that could leave the site', () => {
		for (const value of [
			'https://evil.example/oauth/authorize',
			'//evil.example/oauth/authorize',
			'/\\evil.example/oauth/authorize',
			'\\/evil.example',
			'javascript:alert(1)',
			'oauth/authorize',
			'/oauth/../oauth/authorize/../../account',
			'',
			null,
			undefined
		]) {
			expect(safeReturnTo(value)).toBeNull();
		}
	});

	it('drops a fragment and refuses an oversized value', () => {
		expect(safeReturnTo('/oauth/authorize?a=1#frag')).toBe('/oauth/authorize?a=1');
		expect(safeReturnTo('/oauth/authorize?a=' + 'x'.repeat(5000))).toBeNull();
	});
});

describe('the return-to cookie', () => {
	it('is set only for a returnable page', () => {
		const { cookies } = cookieJar();
		expect(
			rememberReturnTo(cookies, new URL('https://codex.example/oauth/authorize?client_id=a'))
		).toBe(`${RETURN_TO_COOKIE}=${encodeURIComponent('/oauth/authorize?client_id=a')}`);
		expect(rememberReturnTo(cookies, new URL('https://codex.example/account'))).toBeNull();
	});

	it('is refused when it would not fit in a cookie once encoded, and forgets an older one', () => {
		// Short as text, but each character takes three once encoded.
		const long = '/oauth/authorize?state=' + '"'.repeat(1400);
		expect(long.length).toBeLessThan(4000);
		expect(safeReturnTo(long)).toBeNull();
		const { cookies } = cookieJar({ [RETURN_TO_COOKIE]: '/oauth/authorize?client_id=old' });
		expect(rememberReturnTo(cookies, new URL(`https://codex.example${long}`))).toBe(
			`${RETURN_TO_COOKIE}=; Path=/; Max-Age=0`
		);
		// With nothing stored there is nothing to forget.
		expect(
			rememberReturnTo(cookieJar().cookies, new URL(`https://codex.example${long}`))
		).toBeNull();
		// The same for a form posted to the page.
		const { jar, cookies: formCookies } = cookieJar({
			[RETURN_TO_COOKIE]: '/oauth/authorize?client_id=old'
		});
		storeReturnTo(formCookies, null);
		expect(jar.has(RETURN_TO_COOKIE)).toBe(false);
		storeReturnTo(formCookies, '/oauth/authorize?client_id=new');
		expect(jar.get(RETURN_TO_COOKIE)).toBe('/oauth/authorize?client_id=new');
	});

	it('is used once and then forgotten', () => {
		const { jar, cookies } = cookieJar({ [RETURN_TO_COOKIE]: '/oauth/authorize?client_id=a' });
		expect(takeReturnTo(cookies)).toBe('/oauth/authorize?client_id=a');
		expect(jar.has(RETURN_TO_COOKIE)).toBe(false);
		expect(takeReturnTo(cookies)).toBeNull();
	});

	it('is dropped without being followed when it was tampered with', () => {
		const { jar, cookies } = cookieJar({ [RETURN_TO_COOKIE]: 'https://evil.example/' });
		expect(takeReturnTo(cookies)).toBeNull();
		expect(jar.has(RETURN_TO_COOKIE)).toBe(false);
	});
});
