import { describe, expect, it } from 'vitest';
import { estimateCostNote, overLimit } from './cost-notes';

describe('estimateCostNote', () => {
	it('names the total once, with the replies as a share of it', () => {
		expect(estimateCostNote(1.5, 0.6)).toBe(
			'That is about $1.50 in all, of which about $0.60 is for the replies.'
		);
	});

	it('names the total alone when the replies are not broken out', () => {
		expect(estimateCostNote(1.5)).toBe('That is about $1.50 in all.');
	});

	it('says less than a cent instead of $0.00', () => {
		expect(estimateCostNote(0.004, 0.001)).toBe('That is less than $0.01 in all.');
		expect(estimateCostNote(0.5, 0.004)).toBe(
			'That is about $0.50 in all, of which less than $0.01 is for the replies.'
		);
	});
});

describe('overLimit', () => {
	it('compares the figures as they are shown, to the cent', () => {
		expect(overLimit(2.003, 2)).toBe(false);
		expect(overLimit(2.006, 2)).toBe(true);
		expect(overLimit(1.5, 2)).toBe(false);
	});
});
