import { describe, expect, it } from 'vitest';
import { searchingCacheWriteTokens, searchingPromptTokens } from './gateway.ts';
import { WEB_SEARCH_MAX_USES } from './providers/anthropic.ts';

describe('searchingPromptTokens', () => {
	it('counts the prompt every round, each search after it, and the reply after the first', () => {
		expect(WEB_SEARCH_MAX_USES).toBe(5);
		expect(searchingPromptTokens(1000, 100)).toBe(
			10 * 1000 + 10_000 * (9 + 8 + 7 + 6 + 5) + 9 * 100
		);
	});
});

describe('searchingCacheWriteTokens', () => {
	it('counts the final conversation once: the prompt, every search, and the replies before the last round', () => {
		expect(searchingCacheWriteTokens(1000, 100)).toBe(1000 + 5 * 10_000 + 9 * 100);
	});

	it('is never more than the input the loop bills', () => {
		for (const [prompt, reply] of [
			[0, 0],
			[1, 1],
			[20_000, 4000],
			[200_000, 32_000]
		]) {
			expect(searchingCacheWriteTokens(prompt, reply)).toBeLessThanOrEqual(
				searchingPromptTokens(prompt, reply)
			);
		}
	});
});
