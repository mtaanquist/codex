import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	BROWSE_ADULT_KEY,
	browseIndexable,
	decodeCursor,
	encodeCursor,
	parseBrowseQuery,
	withRememberedAdult
} from './browse';

const id = '0b7c2f8e-3d1a-4c5b-9e6f-7a8b9c0d1e2f';

describe('browse query', () => {
	it('reads the search, the filters and the adult choice', () => {
		const query = parseBrowseQuery(
			new URLSearchParams(
				'q=  dragon   song &genre=Fantasy&hide=death&hide=death&hide=abuse&adult=show'
			)
		);
		expect(query).toMatchObject({
			q: 'dragon song',
			genre: 'fantasy',
			fandom: null,
			hide: ['death', 'abuse'],
			adult: true,
			after: null
		});
	});

	it('drops values that are not slugs', () => {
		const query = parseBrowseQuery(new URLSearchParams('tag=<script>&fandom=&hide=a%20b'));
		expect(query.tag).toBeNull();
		expect(query.fandom).toBeNull();
		expect(query.hide).toEqual([]);
	});

	it('round-trips the page cursor and refuses a bad one', () => {
		expect(decodeCursor(encodeCursor('1795507967123456', id))).toEqual({
			micros: '1795507967123456',
			id
		});
		expect(decodeCursor('123_not-an-id')).toBeNull();
		expect(decodeCursor('x')).toBeNull();
		expect(decodeCursor(null)).toBeNull();
	});

	it('lets search engines index the plain page and single filters only', () => {
		const parse = (s: string) => browseIndexable(parseBrowseQuery(new URLSearchParams(s)));
		expect(parse('')).toBe(true);
		expect(parse('genre=fantasy')).toBe(true);
		expect(parse('genre=fantasy&tag=found-family')).toBe(false);
		expect(parse('q=dragon')).toBe(false);
		expect(parse('hide=death')).toBe(false);
		expect(parse('adult=show')).toBe(false);
		expect(parse(`after=${encodeCursor('1795507967123456', id)}`)).toBe(false);
	});
});

describe('remembered adult choice', () => {
	it('adds the adult choice to a Browse address, keeping the other filters', () => {
		expect(
			withRememberedAdult(new URL('https://codex.test/browse?tag=dragons&hide=death'), true)
		).toBe('/browse?tag=dragons&hide=death&adult=show');
		expect(withRememberedAdult(new URL('https://codex.test/browse'), true)).toBe(
			'/browse?adult=show'
		);
	});

	it('leaves the address alone when nothing is remembered or adult work is already in', () => {
		expect(withRememberedAdult(new URL('https://codex.test/browse?q=sea'), false)).toBeNull();
		expect(withRememberedAdult(new URL('https://codex.test/browse?adult=show'), true)).toBeNull();
	});

	it('is applied before first paint from the same storage key', () => {
		const html = readFileSync('src/app.html', 'utf8');
		expect(html).toContain(`localStorage.getItem('${BROWSE_ADULT_KEY}') === 'show'`);
		expect(html).toContain("location.pathname === '/browse'");
	});
});
