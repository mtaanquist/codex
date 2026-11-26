import { describe, it, expect } from 'vitest';
import {
	WEB_SEARCH_FEE_USD,
	cacheReadRate,
	cacheWriteRate,
	usageCostUsd,
	usageRowCostUsd,
	usageTotalPhrase
} from './assistant-cost';

const price = { prompt: 0.001, completion: 0.002 };

describe('usageCostUsd', () => {
	it('prices a row with no cache shares at the plain price', () => {
		const plain = 100 * 0.001 + 10 * 0.002;
		expect(usageCostUsd(price, { promptTokens: 100, completionTokens: 10 })).toBeCloseTo(plain, 10);
		expect(
			usageCostUsd(price, {
				promptTokens: 100,
				completionTokens: 10,
				cachedPromptTokens: null,
				cacheWriteTokens: null,
				cacheWrite1hTokens: null
			})
		).toBeCloseTo(plain, 10);
	});

	it('prices a first read at the write rate of its cache lifetime', () => {
		const written = { promptTokens: 1000, completionTokens: 0, cacheWriteTokens: 1000 };
		expect(usageCostUsd(price, written)).toBeCloseTo(cacheWriteRate('5m'), 10);
		expect(usageCostUsd(price, { ...written, cacheWrite1hTokens: 1000 })).toBeCloseTo(
			cacheWriteRate('1h'),
			10
		);
	});

	it('prices a mixed row share by share', () => {
		// 1000 prompt tokens: 400 read from the cache, 300 written (100 of them
		// to the one hour cache), 300 fresh.
		const cost = usageCostUsd(
			price,
			{
				promptTokens: 1000,
				completionTokens: 50,
				cachedPromptTokens: 400,
				cacheWriteTokens: 300,
				cacheWrite1hTokens: 100
			},
			'anthropic'
		);
		expect(cost).toBeCloseTo((300 + 400 * 0.1 + 200 * 1.25 + 100 * 2) * 0.001 + 50 * 0.002, 10);
	});

	it('prices a cache read at the rate its provider publishes', () => {
		const usage = { promptTokens: 1000, completionTokens: 0, cachedPromptTokens: 400 };
		const withRead = (rate: number) => (600 + 400 * rate) * 0.001;
		expect(usageCostUsd(price, usage, 'anthropic')).toBeCloseTo(withRead(0.1), 10);
		expect(usageCostUsd(price, usage, 'openai')).toBeCloseTo(withRead(0.5), 10);
		expect(usageCostUsd(price, usage, 'gemini')).toBeCloseTo(withRead(0.25), 10);
		expect(usageCostUsd(price, usage, 'deepseek')).toBeCloseTo(withRead(0.26), 10);
	});

	it('gives a cache read no discount on a provider with no known rate', () => {
		const usage = { promptTokens: 1000, completionTokens: 0, cachedPromptTokens: 400 };
		for (const provider of [undefined, '', 'custom', 'openrouter', 'constructor']) {
			expect(cacheReadRate(provider)).toBe(1);
			expect(usageCostUsd(price, usage, provider)).toBeCloseTo(1000 * 0.001, 10);
		}
	});

	it('prices a cache read at the price the endpoint reported, whatever the provider', () => {
		const usage = { promptTokens: 1000, completionTokens: 0, cachedPromptTokens: 400 };
		const reported = { ...price, cacheRead: 0.0003 };
		const cost = 600 * 0.001 + 400 * 0.0003;
		expect(usageCostUsd(reported, usage, 'openrouter')).toBeCloseTo(cost, 10);
		expect(usageCostUsd(reported, usage, 'openai')).toBeCloseTo(cost, 10);
		expect(usageCostUsd({ ...price, cacheRead: 0 }, usage)).toBeCloseTo(600 * 0.001, 10);
	});

	it('adds the fee for each web search on top of the tokens', () => {
		const usage = { promptTokens: 100, completionTokens: 0, webSearchRequests: 3 };
		expect(usageCostUsd(price, usage)).toBeCloseTo(0.1 + 3 * WEB_SEARCH_FEE_USD, 10);
		expect(usageCostUsd({ ...price, webSearch: 0.02 }, usage)).toBeCloseTo(0.1 + 0.06, 10);
		expect(usageCostUsd(price, { ...usage, webSearchRequests: null })).toBeCloseTo(0.1, 10);
	});
});

describe('usageRowCostUsd', () => {
	const pricing = { m: price };
	const row = {
		model: 'm',
		provider: null,
		promptTokens: 1000,
		completionTokens: 0,
		cachedPromptTokens: 1000,
		cacheWriteTokens: null,
		cacheWrite1hTokens: null,
		webSearchRequests: null,
		price: null
	};

	it("prices a row at its own provider's cache rate, not the current one", () => {
		expect(usageRowCostUsd(pricing, { ...row, provider: 'anthropic' }, 'custom')).toBeCloseTo(
			cacheReadRate('anthropic'),
			10
		);
	});

	it('falls back to the current provider for a row with none recorded', () => {
		expect(usageRowCostUsd(pricing, row, 'gemini')).toBeCloseTo(cacheReadRate('gemini'), 10);
		expect(usageRowCostUsd(pricing, row)).toBeCloseTo(cacheReadRate(), 10);
	});

	it('prices a row at the price stored on it, not the current list', () => {
		const stored = { prompt: 0.002, completion: 0 };
		expect(usageRowCostUsd(pricing, { ...row, price: stored }, 'custom')).toBeCloseTo(2, 10);
		expect(usageRowCostUsd({}, { ...row, price: stored }, 'custom')).toBeCloseTo(2, 10);
	});

	it('is null for an unpriced model or a row with no counts', () => {
		expect(usageRowCostUsd(pricing, { ...row, model: 'other' }, 'openai')).toBeNull();
		expect(
			usageRowCostUsd(pricing, { ...row, promptTokens: null, completionTokens: null }, 'openai')
		).toBeNull();
	});
});

describe('usageTotalPhrase', () => {
	const stored = { prompt: 0.00001, completion: 0 };
	const row = (model: string, promptTokens: number | null, unreported = 0) => ({
		model,
		provider: null,
		price: model === 'priced' ? stored : null,
		promptTokens,
		completionTokens: promptTokens === null ? null : 0,
		cachedPromptTokens: null,
		cacheWriteTokens: null,
		cacheWrite1hTokens: null,
		webSearchRequests: null,
		unreported
	});
	const pricing = { priced: { prompt: 0.00001, completion: 0 } };

	it('gives a plain total when every request was priced', () => {
		expect(usageTotalPhrase(pricing, [row('priced', 40000)], false)).toBe('about $0.40');
	});

	it('gives a floor when a model has no price', () => {
		expect(usageTotalPhrase(pricing, [row('priced', 40000), row('other', 10)], false)).toBe(
			'at least $0.40, as some requests could not be priced'
		);
	});

	it('gives a floor when some requests reported no counts', () => {
		expect(usageTotalPhrase(pricing, [row('priced', 40000, 1)], false)).toBe(
			'at least $0.40, as some requests could not be priced'
		);
	});

	it('does not claim a floor over estimated counts', () => {
		expect(usageTotalPhrase(pricing, [row('priced', 40000, 1)], true)).toBe(
			'about $0.40, and some requests could not be priced'
		);
	});

	it("does not claim a floor over rows priced at today's list", async () => {
		const old = { ...row('priced', 40000), price: null };
		expect(usageTotalPhrase(pricing, [old, row('other', 10)], false)).toBe(
			'about $0.40, and some requests could not be priced'
		);
	});

	it('names no amount under a cent when some requests could not be priced', () => {
		expect(usageTotalPhrase(pricing, [row('priced', 100), row('other', 10)], false)).toBe(
			'some requests could not be priced'
		);
	});

	it('is null when nothing could be priced', () => {
		expect(usageTotalPhrase(pricing, [row('other', 10), row('priced', null)], false)).toBeNull();
	});
});
