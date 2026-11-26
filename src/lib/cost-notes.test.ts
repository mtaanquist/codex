import { describe, expect, it } from 'vitest';
import { estimateCostNote } from './cost-notes';

describe('estimateCostNote', () => {
	it('names the total once, with the replies as a share of it', () => {
		expect(estimateCostNote(1.5, 0.6)).toBe(
			'That is about $1.50 in all, of which about $0.60 is for the replies.'
		);
	});

	it('names the total alone when the replies are not broken out', () => {
		expect(estimateCostNote(1.5)).toBe('That is about $1.50 in all.');
	});
});
