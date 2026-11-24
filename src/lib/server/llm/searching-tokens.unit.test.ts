import { describe, expect, it } from 'vitest';
import { searchingPromptTokens } from './gateway.ts';
import { WEB_SEARCH_MAX_USES } from './providers/anthropic.ts';

describe('searchingPromptTokens', () => {
	it('counts the prompt every round, and every search and the reply in every round after the first', () => {
		expect(WEB_SEARCH_MAX_USES).toBe(5);
		expect(searchingPromptTokens(1000, 100)).toBe(10 * 1000 + 5 * 10_000 * 9 + 9 * 100);
	});

	it('holds when every search runs in the first round', () => {
		// Five parallel searches in round 1 put all their results in rounds 2 to 10.
		const worstCase = 10 * 20_000 + 5 * 10_000 * 9 + 9 * 4000;
		expect(searchingPromptTokens(20_000, 4000)).toBeGreaterThanOrEqual(worstCase);
		expect(searchingPromptTokens(20_000, 4000)).toBe(686_000);
	});
});
