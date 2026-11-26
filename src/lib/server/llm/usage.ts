import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { WEB_SEARCH_FEE_USD, type TokenPrice } from '../../assistant-cost.ts';
import type { Database } from '../auth.ts';
import { assistantUsage } from '../db/schema.ts';
import { logEvent } from '../log.ts';
import { pageIndex } from '../paging.ts';
import type { TokenUsage } from './providers/types.ts';

// The usage log: one row of metadata per request the gateway sends to the
// writer's endpoint, so the account page can show what the Assistant has been
// costing. Token counts come from the endpoint's own report and are null when
// it sent none. A request that failed or was cancelled before the endpoint
// reported its totals carries the adapter's estimate instead, and its row is
// marked estimated so it is never shown as a reported count. Prompt text is
// never stored.

export type UsageEntry = {
	userId: string;
	storyId?: string;
	role: string;
	// The provider id the request went to (see PROVIDER_IDS).
	provider?: string;
	model: string;
	usage?: TokenUsage;
	// The model's price in force now, stored so the row keeps its cost after
	// the price list changes (see UsageCostRow.price).
	price?: TokenPrice;
	// The gateway's own chars/4 estimate for the request it just sent, when it
	// computed one. Logged against the endpoint's report, never stored.
	estimatedPromptTokens?: number;
};

// Observability for the token estimate the budgets are built on. The estimate
// is chars/4, which skews with non-English prose and with heavy markup, and
// budgets (context assembly, the agent loop's context guard) are increasingly
// load-bearing. Logging estimate against the endpoint's own count is phase one:
// once the ratios are observed per endpoint, a correction factor can be applied
// where estimateTokens feeds those budgets.
function logEstimateAccuracy(entry: UsageEntry): void {
	const actual = entry.usage?.promptTokens;
	const estimated = entry.estimatedPromptTokens;
	if (!actual || estimated === undefined || entry.usage?.estimated) return;
	logEvent('info', 'assistant.usage.estimate', {
		model: entry.model,
		estimated,
		actual,
		ratio: Math.round((estimated / actual) * 100) / 100
	});
}

// The price as it stands, with the search fee pinned when the request searched
// so a later change to the fee does not reprice it either.
function storedPrice(price: TokenPrice, usage?: TokenUsage): TokenPrice {
	return usage?.webSearchRequests
		? { ...price, webSearch: price.webSearch ?? WEB_SEARCH_FEE_USD }
		: price;
}

// Recording must never break a generation; a failed insert is logged and
// dropped.
export async function recordAssistantUsage(db: Database, entry: UsageEntry): Promise<void> {
	logEstimateAccuracy(entry);
	try {
		await db.insert(assistantUsage).values({
			userId: entry.userId,
			storyId: entry.storyId ?? null,
			role: entry.role,
			provider: entry.provider ?? null,
			model: entry.model,
			promptTokens: entry.usage?.promptTokens ?? null,
			completionTokens: entry.usage?.completionTokens ?? null,
			cachedPromptTokens: entry.usage?.cachedPromptTokens ?? null,
			cacheWriteTokens: entry.usage?.cacheWriteTokens ?? null,
			cacheWrite1hTokens: entry.usage?.cacheWrite1hTokens ?? null,
			estimated: entry.usage?.estimated ?? false,
			webSearchRequests: entry.usage?.webSearchRequests ?? null,
			price: entry.price ? storedPrice(entry.price, entry.usage) : null
		});
	} catch (err) {
		logEvent('warn', 'assistant.usage', {
			userId: entry.userId,
			error: err instanceof Error ? err.message : 'insert failed'
		});
	}
}

export type UsageRow = {
	id: string;
	role: string;
	// Null on a row from before the provider was recorded.
	provider: string | null;
	model: string;
	promptTokens: number | null;
	completionTokens: number | null;
	// The cache shares of promptTokens; null where none were reported.
	cachedPromptTokens: number | null;
	cacheWriteTokens: number | null;
	cacheWrite1hTokens: number | null;
	estimated: boolean;
	webSearchRequests: number | null;
	// The price stored when the request was sent (see recordAssistantUsage).
	price: TokenPrice | null;
	createdAt: Date;
};

export type UsageSummary = {
	// One page of requests, newest first.
	recent: UsageRow[];
	// The zero-based page recent holds, and whether older pages exist.
	page: number;
	hasMore: boolean;
	// Thirty-day totals across all requests, not just the listed ones.
	// estimatedRequests counts the rows whose counts are estimates.
	totals: {
		requests: number;
		promptTokens: number;
		completionTokens: number;
		estimatedRequests: number;
		webSearchRequests: number;
	};
	// Thirty-day token sums per model, provider and stored price, so a caller
	// can price the period at the price each request was sent at, falling back
	// to its current prices for rows from before the price was stored.
	byModel: {
		provider: string | null;
		model: string;
		price: TokenPrice | null;
		promptTokens: number | null;
		completionTokens: number | null;
		cachedPromptTokens: number;
		cacheWriteTokens: number;
		cacheWrite1hTokens: number;
		webSearchRequests: number;
		// Requests in the group that reported no token counts at all.
		unreported: number;
	}[];
};

export const USAGE_PAGE_SIZE = 50;
const TOTALS_DAYS = 30;

export async function recentAssistantUsage(
	db: Database,
	userId: string,
	page = 0
): Promise<UsageSummary> {
	const safePage = pageIndex(page);
	// Fetch one row past the page to learn whether an older page exists.
	const rows = await db
		.select({
			id: assistantUsage.id,
			role: assistantUsage.role,
			provider: assistantUsage.provider,
			model: assistantUsage.model,
			promptTokens: assistantUsage.promptTokens,
			completionTokens: assistantUsage.completionTokens,
			cachedPromptTokens: assistantUsage.cachedPromptTokens,
			cacheWriteTokens: assistantUsage.cacheWriteTokens,
			cacheWrite1hTokens: assistantUsage.cacheWrite1hTokens,
			estimated: assistantUsage.estimated,
			webSearchRequests: assistantUsage.webSearchRequests,
			price: assistantUsage.price,
			createdAt: assistantUsage.createdAt
		})
		.from(assistantUsage)
		.where(eq(assistantUsage.userId, userId))
		.orderBy(desc(assistantUsage.createdAt))
		.limit(USAGE_PAGE_SIZE + 1)
		.offset(safePage * USAGE_PAGE_SIZE);
	const recent = rows.slice(0, USAGE_PAGE_SIZE);

	const since = new Date(Date.now() - TOTALS_DAYS * 24 * 60 * 60 * 1000);
	const [totals] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			promptTokens: sql<number>`coalesce(sum(${assistantUsage.promptTokens}), 0)::float8`,
			completionTokens: sql<number>`coalesce(sum(${assistantUsage.completionTokens}), 0)::float8`,
			estimatedRequests: sql<number>`(count(*) filter (where ${assistantUsage.estimated}))::int`,
			webSearchRequests: sql<number>`coalesce(sum(${assistantUsage.webSearchRequests}), 0)::float8`
		})
		.from(assistantUsage)
		.where(and(eq(assistantUsage.userId, userId), gte(assistantUsage.createdAt, since)));

	// Sums are float8, not int: thirty days of tokens can pass 2^31, and float8
	// holds whole numbers exactly far beyond that and reaches here as a number.
	const byModel = await db
		.select({
			provider: assistantUsage.provider,
			model: assistantUsage.model,
			price: assistantUsage.price,
			// Null when no row in the group reported counts, so it prices as
			// unknown rather than free.
			promptTokens: sql<number | null>`sum(${assistantUsage.promptTokens})::float8`,
			completionTokens: sql<number | null>`sum(${assistantUsage.completionTokens})::float8`,
			cachedPromptTokens: sql<number>`coalesce(sum(${assistantUsage.cachedPromptTokens}), 0)::float8`,
			cacheWriteTokens: sql<number>`coalesce(sum(${assistantUsage.cacheWriteTokens}), 0)::float8`,
			cacheWrite1hTokens: sql<number>`coalesce(sum(${assistantUsage.cacheWrite1hTokens}), 0)::float8`,
			webSearchRequests: sql<number>`coalesce(sum(${assistantUsage.webSearchRequests}), 0)::float8`,
			// Requests in the group that reported no counts, which a sum leaves out.
			unreported: sql<number>`(count(*) filter (where ${assistantUsage.promptTokens} is null and ${assistantUsage.completionTokens} is null))::int`
		})
		.from(assistantUsage)
		.where(and(eq(assistantUsage.userId, userId), gte(assistantUsage.createdAt, since)))
		.groupBy(assistantUsage.model, assistantUsage.provider, assistantUsage.price);

	return {
		recent,
		page: safePage,
		hasMore: rows.length > USAGE_PAGE_SIZE,
		totals: totals ?? {
			requests: 0,
			promptTokens: 0,
			completionTokens: 0,
			estimatedRequests: 0,
			webSearchRequests: 0
		},
		byModel
	};
}
