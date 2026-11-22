// What a request costs, from its token counts and a per-token price. The one
// place the cache rates live: the spend meter, the review estimate, and the
// usage list on the account page all price through here.

// cacheRead is what a token read from the prompt cache costs, where the
// endpoint reports it per model (OpenRouter's discovery does); without it the
// provider's rate below applies.
export type TokenPrice = { prompt: number; completion: number; cacheRead?: number };

// The counts a cost is built from. The cache counts are subsets of
// promptTokens: cacheWrite1hTokens of cacheWriteTokens, and cacheWriteTokens
// and cachedPromptTokens of promptTokens. Absent or null means none.
export type CostedUsage = {
	promptTokens: number;
	completionTokens: number;
	cachedPromptTokens?: number | null;
	cacheWriteTokens?: number | null;
	cacheWrite1hTokens?: number | null;
};

// Cache reads bill at a fraction of fresh prompt tokens, as a multiple of the
// plain prompt price, for the providers whose adapters report cached tokens
// and who publish one rate. Where a provider's models differ, the dearest
// fraction is used, so a figure can read high but never low, and a cap never
// stops late. Claude: a tenth. OpenAI: from a tenth to a half by model.
// Gemini: a quarter, or less on newer models. DeepSeek: a tenth. Any other
// endpoint (a gateway or a custom server) can charge anything up to the full
// price, so its cached tokens get no discount, unless the price itself says
// what a cache read costs (TokenPrice.cacheRead).
const CACHE_READ_RATES = new Map<string, number>([
	['anthropic', 0.1],
	['openai', 0.5],
	['gemini', 0.25],
	['deepseek', 0.1]
]);
const UNKNOWN_CACHE_READ_RATE = 1;

// What a token read from the endpoint's prompt cache bills at, as a multiple
// of the plain prompt price. provider: the account's provider id (see
// PROVIDER_IDS); absent or unknown gets no discount.
export function cacheReadRate(provider?: string): number {
	return CACHE_READ_RATES.get(provider ?? '') ?? UNKNOWN_CACHE_READ_RATE;
}

// Cache writes bill above the plain prompt rate. Only Claude reports them, at
// these multiples for its five-minute and one-hour caches.
const CACHE_WRITE_RATE = 1.25;
const CACHE_WRITE_1H_RATE = 2;

// What text sent for the first time bills at, as a multiple of the plain
// prompt price, when it is written to a cache of this lifetime.
export function cacheWriteRate(ttl: '5m' | '1h'): number {
	return ttl === '1h' ? CACHE_WRITE_1H_RATE : CACHE_WRITE_RATE;
}

function share(value: number | null | undefined, max: number): number {
	return Math.min(Math.max(value ?? 0, 0), max);
}

// provider: the provider the request went to (see cacheReadRate).
export function usageCostUsd(price: TokenPrice, usage: CostedUsage, provider?: string): number {
	const cached = share(usage.cachedPromptTokens, usage.promptTokens);
	const written = share(usage.cacheWriteTokens, usage.promptTokens - cached);
	const writtenHour = share(usage.cacheWrite1hTokens, written);
	const fresh = usage.promptTokens - cached - written;
	const promptUnits =
		fresh + (written - writtenHour) * CACHE_WRITE_RATE + writtenHour * CACHE_WRITE_1H_RATE;
	const cachedUsd = cached * (price.cacheRead ?? price.prompt * cacheReadRate(provider));
	return promptUnits * price.prompt + cachedUsd + usage.completionTokens * price.completion;
}
