import { describe, expect, it } from 'vitest';
import { capCeilingUsage, searchAllowanceFields, searchingPromptTokens } from './gateway.ts';
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

describe('capCeilingUsage', () => {
	it('reserves the fee for every search a searching request may make', () => {
		const usage = capCeilingUsage(1000, 100, { webSearch: true, claude: true });
		expect(usage.webSearchRequests).toBe(WEB_SEARCH_MAX_USES);
		expect(capCeilingUsage(1000, 100, { claude: true }).webSearchRequests).toBeUndefined();
	});
});

describe('searchAllowanceFields', () => {
	it('compares reported input with the room held for it', () => {
		const allowance = searchingPromptTokens(1000, 100);
		expect(
			searchAllowanceFields(1000, 100, {
				promptTokens: allowance + 1,
				completionTokens: 0,
				webSearchRequests: 2
			})
		).toEqual({ searches: 2, reported: allowance + 1, allowance, overAllowance: true });
		expect(
			searchAllowanceFields(1000, 100, {
				promptTokens: 5,
				completionTokens: 0,
				webSearchRequests: 1
			})?.overAllowance
		).toBe(false);
	});

	it('says nothing without searches or with estimated counts', () => {
		expect(
			searchAllowanceFields(1000, 100, { promptTokens: 5, completionTokens: 0 })
		).toBeUndefined();
		expect(
			searchAllowanceFields(1000, 100, {
				promptTokens: 5,
				completionTokens: 0,
				webSearchRequests: 1,
				estimated: true
			})
		).toBeUndefined();
		expect(searchAllowanceFields(1000, 100)).toBeUndefined();
	});
});
