import { describe, expect, it } from 'vitest';
import { searchingPromptTokens } from './gateway.ts';
import { WEB_SEARCH_MAX_USES } from './providers/anthropic.ts';

describe('searchingPromptTokens', () => {
	it('counts the prompt every round, each search after it, and the reply after the first', () => {
		expect(WEB_SEARCH_MAX_USES).toBe(5);
		expect(searchingPromptTokens(1000, 100)).toBe(
			10 * 1000 + 10_000 * (9 + 8 + 7 + 6 + 5) + 9 * 100
		);
	});
});
