import { describe, it, expect } from 'vitest';
import { MAX_PAGE, pageIndex } from './paging';

describe('pageIndex', () => {
	it('keeps a whole page and floors a fractional one', () => {
		expect(pageIndex(3)).toBe(3);
		expect(pageIndex(2.7)).toBe(2);
	});

	it('turns negative and non-finite input into the first page', () => {
		expect(pageIndex(-4)).toBe(0);
		expect(pageIndex(Number.NaN)).toBe(0);
		expect(pageIndex(-Infinity)).toBe(0);
		expect(pageIndex(Infinity)).toBe(0);
	});

	it('caps a huge page', () => {
		expect(pageIndex(1e20)).toBe(MAX_PAGE);
	});
});
