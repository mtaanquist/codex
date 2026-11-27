import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { chapters, entityMentions, scenes, stories } from '../db/schema.ts';
import { defaultMaxTokens } from '../../assistant-tuning.ts';
import { entityAppearances } from '../plan-data.ts';
import { storyAssistantOn, storyIsLive } from '../universe-scope.ts';
import { chapterShown } from '../chapter-sql.ts';
import { estimateTokens, PERSONA_TOKENS, tokensForChars } from './context/budgets.ts';
import { modelContextWindow, pickModel, resolveLlmConfig, roleMaxTokens } from './config.ts';
import { adapterKind } from './providers/presets.ts';
import { cacheWriteRate } from '../../assistant-cost.ts';
import type { EntityKind } from '../entity-suggestions.ts';
import { errorFields, logEvent } from '../log.ts';
import { SpendCapError, type SpendMeter } from './spend.ts';
import {
	embed,
	EmbeddingsDisabledError,
	embeddingsSettings,
	type EmbedDeps
} from './embeddings/index.ts';
import { embeddingIndexFor, nearestChunks } from './embeddings/scene-index.ts';

// What a "find more" read of an entity sends: the short snippets around each
// indexed mention (the background pass), the full text of the scenes that
// mention it with the scene before and after each, or the whole book.
export const ENRICH_MODES = ['snippets', 'scenes', 'book'] as const;
export type EnrichMode = (typeof ENRICH_MODES)[number];
export type EnrichTextMode = Exclude<EnrichMode, 'snippets'>;

type Scope = { storyId: string } | { universeId: string };

export type ExcerptScene = {
	id: string;
	storyId: string;
	storyTitle: string;
	chapterTitle: string;
	title: string | null;
	bodyMd: string;
	// A passage found by meaning (see relatedPassages) rather than a scene that
	// names the entity: only part of its scene, and perhaps not about it.
	related?: true;
};

// The share of the model's window one request's text may fill with the reply
// reserved on top, the same rule as the whole-book pattern pass.
const WINDOW_SHARE = 0.8;
// The text budget per request when the window is unknown, which may be a small
// local model.
export const UNKNOWN_WINDOW_PART_TOKENS = 6000;
const MIN_PART_TOKENS = 1000;
// The instructions, the entity's known fields and the facts carried forward
// from earlier parts. An allowance, not measured.
const TASK_TOKENS = 600;
// The reply cap a text read asks for: more is found in whole scenes than in
// snippets.
export const ENRICH_TEXT_REPLY_TOKENS = 1500;
// A read estimated above this is confirmed by the writer before it runs.
export const ENRICH_CONFIRM_TOKENS = 8000;
// The story and chapter headings a scene may bring with it. An allowance.
const HEADING_TOKENS = 16;

// The mentioned scenes plus the scene before and after each within its own
// story. `order` is every readable scene in reading order. Pure.
export function withNeighbours(
	order: { id: string; storyId: string }[],
	mentioned: ReadonlySet<string>
): Set<string> {
	const picked = new Set<string>();
	order.forEach((scene, i) => {
		if (!mentioned.has(scene.id)) return;
		picked.add(scene.id);
		for (const near of [order[i - 1], order[i + 1]]) {
			if (near && near.storyId === scene.storyId) picked.add(near.id);
		}
	});
	return picked;
}

// A scene longer than the budget, cut at paragraph breaks into pieces that
// fit; a single paragraph longer than the budget is cut where it must be.
function splitBody(bodyMd: string, budgetChars: number): string[] {
	const pieces: string[] = [];
	let current = '';
	for (const paragraph of bodyMd.split(/\n{2,}/)) {
		let rest = paragraph;
		while (rest.length > budgetChars) {
			if (current) {
				pieces.push(current);
				current = '';
			}
			pieces.push(rest.slice(0, budgetChars));
			rest = rest.slice(budgetChars);
		}
		if (current && current.length + rest.length + 2 > budgetChars) {
			pieces.push(current);
			current = '';
		}
		current = current ? `${current}\n\n${rest}` : rest;
	}
	if (current) pieces.push(current);
	return pieces;
}

function sceneBlock(scene: ExcerptScene): string {
	const title = (scene.title ?? '').trim() || 'Untitled scene';
	return `### ${title}\n${scene.bodyMd.trim() || '(empty)'}`;
}

export const RELATED_HEADING =
	'# Passages that may be about it\n' +
	'These passages do not name it. They were found because they read like what is known about it, and some may be about someone or something else.';

// The scenes as one text in reading order, with a heading where the story
// (when more than one is read) or the chapter changes. Passages found by
// meaning come last, under a heading of their own. Pure.
export function formatExcerpts(list: ExcerptScene[], withStory: boolean): string {
	const out: string[] = [];
	let story: string | undefined;
	let chapter: string | undefined;
	let related = false;
	for (const scene of list) {
		if (scene.related) {
			if (!related) out.push(RELATED_HEADING);
			related = true;
			const title = (scene.title ?? '').trim() || 'Untitled scene';
			const where = withStory ? `${scene.storyTitle.trim() || 'Untitled story'} / ${title}` : title;
			out.push(`### ${where}\n${scene.bodyMd.trim()}`);
			continue;
		}
		if (withStory && scene.storyId !== story) {
			out.push(`# ${scene.storyTitle.trim() || 'Untitled story'}`);
			chapter = undefined;
		}
		if (scene.storyId !== story || scene.chapterTitle !== chapter) {
			out.push(`## ${scene.chapterTitle}`);
		}
		story = scene.storyId;
		chapter = scene.chapterTitle;
		out.push(sceneBlock(scene));
	}
	return out.join('\n\n');
}

// The scenes in parts that each fit the budget, in reading order. A scene too
// long for one part is cut into several. Pure.
export function splitExcerptParts(list: ExcerptScene[], budgetTokens: number): ExcerptScene[][] {
	const budgetChars = Math.max(budgetTokens, 1) * 4;
	const parts: ExcerptScene[][] = [];
	let current: ExcerptScene[] = [];
	let used = 0;
	for (const scene of list) {
		const pieces =
			tokensForChars(scene.bodyMd.length) > budgetTokens
				? splitBody(scene.bodyMd, budgetChars).map((bodyMd) => ({ ...scene, bodyMd }))
				: [scene];
		for (const piece of pieces) {
			const tokens = estimateTokens(sceneBlock(piece)) + HEADING_TOKENS;
			if (current.length > 0 && used + tokens > budgetTokens) {
				parts.push(current);
				current = [];
				used = 0;
			}
			current.push(piece);
			used += tokens;
		}
	}
	if (current.length) parts.push(current);
	return parts;
}

// The text one request may carry for a model with this window and reply cap.
// Pure.
export function partBudgetTokens(contextWindow: number | undefined, replyTokens: number): number {
	if (!contextWindow) return UNKNOWN_WINDOW_PART_TOKENS;
	return Math.max(
		MIN_PART_TOKENS,
		Math.floor(contextWindow * WINDOW_SHARE) - replyTokens - PERSONA_TOKENS - TASK_TOKENS
	);
}

// Every scene the Assistant may read in the scope, in reading order, with or
// without its text. Owner-scoped; muted and trashed stories are left out.
async function readableScenes(db: Database, userId: string, scope: Scope, ids?: string[]) {
	if (ids && ids.length === 0) return [];
	return await db
		.select({
			id: scenes.id,
			storyId: stories.id,
			storyTitle: stories.title,
			chapterId: scenes.chapterId,
			chapterTitle: chapterShown,
			title: scenes.title,
			bodyMd: ids ? scenes.bodyMd : sql<string>`''`,
			bodyChars: sql<number>`length(${scenes.bodyMd})`.mapWith(Number)
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.leftJoin(chapters, eq(chapters.id, scenes.chapterId))
		.where(
			and(
				eq(stories.ownerId, userId),
				'storyId' in scope
					? eq(stories.id, scope.storyId)
					: eq(stories.universeId, scope.universeId),
				storyIsLive(),
				storyAssistantOn(),
				isNull(scenes.deletedAt),
				ids ? inArray(scenes.id, ids) : undefined
			)
		)
		.orderBy(asc(stories.positionInSeries), asc(stories.createdAt), asc(scenes.globalPosition));
}

type ReadableScene = Awaited<ReturnType<typeof readableScenes>>[number];

function toExcerpt(row: ReadableScene): ExcerptScene {
	return {
		id: row.id,
		storyId: row.storyId,
		storyTitle: row.storyTitle,
		chapterTitle: row.chapterId ? row.chapterTitle.trim() : 'Unfiled scenes',
		title: row.title,
		bodyMd: row.bodyMd
	};
}

// The ids a text read covers, in reading order, with each scene's length.
// 'book' is every scene of the story and needs a story scope.
async function excerptOutline(
	db: Database,
	opts: { userId: string; scope: Scope; kind: EntityKind; entityId: string; mode: EnrichTextMode }
): Promise<ReadableScene[]> {
	if (opts.mode === 'book' && !('storyId' in opts.scope)) return [];
	const order = await readableScenes(db, opts.userId, opts.scope);
	if (opts.mode === 'book') return order;
	const appearances = await entityAppearances(
		db,
		{ kind: opts.kind, id: opts.entityId },
		opts.scope,
		{ assistant: true }
	);
	const picked = withNeighbours(order, new Set(appearances.map((a) => a.sceneId)));
	return order.filter((scene) => picked.has(scene.id));
}

// The scenes a text read sends, with their text.
export async function entityExcerpts(
	db: Database,
	opts: { userId: string; scope: Scope; kind: EntityKind; entityId: string; mode: EnrichTextMode }
): Promise<ExcerptScene[]> {
	const outline = await excerptOutline(db, opts);
	const rows = await readableScenes(
		db,
		opts.userId,
		opts.scope,
		outline.map((scene) => scene.id)
	);
	return rows.map(toExcerpt);
}

// Whether a read with nothing to send would have had scenes but for stories
// muted for the Assistant or in the trash, so the writer is told that rather
// than that nothing mentions the entity. Reads ids only, never text.
export async function excerptsWithheld(
	db: Database,
	opts: { userId: string; scope: Scope; kind: EntityKind; entityId: string; mode: EnrichTextMode }
): Promise<boolean> {
	if (opts.mode === 'book' && !('storyId' in opts.scope)) return false;
	const inScope = and(
		eq(stories.ownerId, opts.userId),
		'storyId' in opts.scope
			? eq(stories.id, opts.scope.storyId)
			: eq(stories.universeId, opts.scope.universeId),
		isNull(scenes.deletedAt),
		sql`not (${storyIsLive()} and ${storyAssistantOn()})`
	);
	const targetType = opts.kind === 'lore' ? 'lore_entry' : opts.kind;
	const rows =
		opts.mode === 'book'
			? await db
					.select({ id: scenes.id })
					.from(scenes)
					.innerJoin(stories, eq(scenes.storyId, stories.id))
					.where(inScope)
					.limit(1)
			: await db
					.select({ id: scenes.id })
					.from(entityMentions)
					.innerJoin(scenes, eq(entityMentions.sourceId, scenes.id))
					.innerJoin(stories, eq(scenes.storyId, stories.id))
					.where(
						and(
							eq(entityMentions.sourceType, 'scene'),
							eq(entityMentions.targetType, targetType),
							eq(entityMentions.targetId, opts.entityId),
							inScope
						)
					)
					.limit(1);
	return rows.length > 0;
}

// The model a text read runs on and the text each request may carry.
export async function enrichTextBudget(db: Database, userId: string, scope: Scope) {
	const resolved = await resolveLlmConfig(db, userId, scope);
	const model = pickModel(resolved.config, 'utility');
	const contextWindow = modelContextWindow(resolved.config, 'utility');
	// The larger of what the read asks for and what the gateway may raise it to
	// for a model that thinks, so the text never crowds out the reply.
	const replyTokens =
		roleMaxTokens(resolved.config, 'utility') ??
		Math.max(ENRICH_TEXT_REPLY_TOKENS, defaultMaxTokens('utility', true, contextWindow));
	return {
		model,
		contextWindow,
		replyTokens,
		partTokens: partBudgetTokens(contextWindow, replyTokens),
		price: model ? resolved.config.modelPricing?.[model] : undefined,
		// Claude caches every request, so its text bills at the cache-write rate
		// (see cacheWriteRate). Each part's excerpts are new; the shared persona
		// may be read back from the cache instead, so the figure errs high.
		promptRate:
			adapterKind(resolved.config.provider) === 'anthropic'
				? cacheWriteRate(resolved.config.cacheTtl)
				: 1
	};
}

// Passages found by meaning: at most this many, taking at most this share of
// one request's text.
export const RELATED_PASSAGES = 12;
const RELATED_SHARE = 0.25;
// Closest passages asked of the index, so there are enough left once those in
// scenes already read are dropped.
const RELATED_CANDIDATES = 40;
// The longest query sent to the embeddings model.
const RELATED_QUERY_CHARS = 2000;

// The text the related passages one request may carry. Pure.
export function relatedBudgetTokens(partTokens: number): number {
	return Math.floor(partTokens * RELATED_SHARE);
}

// What is known about the entity, as the text its passages are compared with.
// Pure.
export function relatedQuery(fields: {
	name: string;
	aliases: string[];
	summaryMd: string | null;
	details: { label: string; value: string }[];
}): string {
	const lines = [
		fields.name.trim(),
		fields.aliases.length ? `Also called: ${fields.aliases.join(', ')}.` : '',
		(fields.summaryMd ?? '').trim(),
		...fields.details.map((d) => `${d.label}: ${d.value}`)
	];
	return lines.filter(Boolean).join('\n').slice(0, RELATED_QUERY_CHARS);
}

// The nearest passages, nearest first, without those from scenes already read,
// up to RELATED_PASSAGES and the token budget. Pure.
export function pickRelated(
	chunks: {
		sceneId: string;
		storyId: string;
		content: string;
		sceneTitle: string | null;
		storyTitle: string;
	}[],
	exclude: ReadonlySet<string>,
	budgetTokens: number
): ExcerptScene[] {
	const picked: ExcerptScene[] = [];
	let used = 0;
	for (const chunk of chunks) {
		if (picked.length >= RELATED_PASSAGES) break;
		if (exclude.has(chunk.sceneId) || !chunk.content.trim()) continue;
		const passage: ExcerptScene = {
			id: chunk.sceneId,
			storyId: chunk.storyId,
			storyTitle: chunk.storyTitle,
			chapterTitle: '',
			title: chunk.sceneTitle,
			bodyMd: chunk.content,
			related: true
		};
		const tokens = estimateTokens(sceneBlock(passage)) + HEADING_TOKENS;
		if (used + tokens > budgetTokens) break;
		picked.push(passage);
		used += tokens;
	}
	return picked;
}

// Whether the universe has a finished index on the writer's current
// embeddings model. Without one a read sends what it always has.
async function relatedIndexReady(db: Database, userId: string, universeId: string) {
	const config = await embeddingsSettings(db, userId);
	if (!config.ready) return false;
	const index = await embeddingIndexFor(db, userId, universeId);
	return !!index?.completedAt && index.model === config.model;
}

// The passages in the scope closest in meaning to what is known about the
// entity, from scenes not already read, when the universe has an index; none
// otherwise. Embedding the query is a request of its own, recorded on the
// meter. A failure here leaves the passages out rather than failing the read;
// a request the cap held back leaves the meter at its cap, so the read stops
// as capped.
export async function relatedPassages(
	db: Database,
	opts: {
		userId: string;
		scope: Scope;
		universeId: string;
		query: string;
		exclude: ReadonlySet<string>;
		budgetTokens: number;
		meter?: SpendMeter;
		signal?: AbortSignal;
	},
	deps: EmbedDeps = {}
): Promise<ExcerptScene[]> {
	if (!opts.query.trim() || opts.budgetTokens <= 0) return [];
	if (!(await relatedIndexReady(db, opts.userId, opts.universeId))) return [];
	try {
		const embedded = await embed(
			db,
			opts.userId,
			[opts.query],
			{ meter: opts.meter, signal: opts.signal },
			deps
		);
		const chunks = await nearestChunks(
			db,
			opts.userId,
			opts.scope,
			{ model: embedded.model, vector: embedded.vectors[0] ?? [] },
			RELATED_CANDIDATES
		);
		return pickRelated(chunks, opts.exclude, opts.budgetTokens);
	} catch (err) {
		if (!(err instanceof EmbeddingsDisabledError || err instanceof SpendCapError)) {
			logEvent('warn', 'assistant.enrich_related_failed', {
				userId: opts.userId,
				...errorFields(err)
			});
		}
		return [];
	}
}

export type EnrichReadEstimate = {
	scenes: number;
	// A scene longer than one request is counted as if it could be cut
	// anywhere; the read cuts at paragraph breaks, so it can take one more.
	requests: number;
	// Prompt tokens across every request.
	estTokens: number;
	// Present only when the model has a price.
	estCostUsd?: number;
};

export type EnrichEstimate = {
	model: string;
	// The scenes that mention the entry, with the scene before and after each.
	scenes: EnrichReadEstimate;
	// The whole book; present only from a story whose text fits one request.
	book?: EnrichReadEstimate;
	// Whether the scenes read is large enough to confirm first.
	confirm: boolean;
};

function readEstimate(
	outline: ReadableScene[],
	budget: Awaited<ReturnType<typeof enrichTextBudget>>,
	taskTokens: number,
	relatedTokens = 0
): EnrichReadEstimate {
	// Lengths stand in for the text, so nothing is loaded to count it.
	const sized: ExcerptScene[] = outline.map((row) => ({
		...toExcerpt(row),
		bodyMd: 'x'.repeat(row.bodyChars)
	}));
	// Passages found by meaning are counted at the most they may take.
	if (relatedTokens > 0 && sized.length > 0) {
		sized.push({ ...sized[0], bodyMd: 'x'.repeat(relatedTokens * 4), related: true });
	}
	const parts = splitExcerptParts(sized, budget.partTokens);
	const withStory = new Set(outline.map((row) => row.storyId)).size > 1;
	const estTokens = parts.reduce(
		(sum, part) =>
			sum + PERSONA_TOKENS + taskTokens + estimateTokens(formatExcerpts(part, withStory)),
		0
	);
	const completion = parts.length * ENRICH_TEXT_REPLY_TOKENS;
	return {
		scenes: outline.length,
		requests: parts.length,
		estTokens,
		...(budget.price
			? {
					estCostUsd:
						estTokens * budget.promptRate * budget.price.prompt +
						completion * budget.price.completion
				}
			: {})
	};
}

// What a text read of this entity would send, counted without sending it.
// taskTokens is the size of the request around the text: the entity's known
// fields and the instructions.
export async function estimateEnrich(
	db: Database,
	opts: {
		userId: string;
		scope: Scope;
		kind: EntityKind;
		entityId: string;
		universeId: string;
		taskTokens: number;
	}
): Promise<EnrichEstimate> {
	const budget = await enrichTextBudget(db, opts.userId, opts.scope);
	const count = (outline: ReadableScene[], relatedTokens = 0) =>
		readEstimate(outline, budget, opts.taskTokens, relatedTokens);
	const related = (await relatedIndexReady(db, opts.userId, opts.universeId))
		? relatedBudgetTokens(budget.partTokens)
		: 0;
	const scenesRead = count(await excerptOutline(db, { ...opts, mode: 'scenes' }), related);
	let book: EnrichReadEstimate | undefined;
	if ('storyId' in opts.scope && budget.contextWindow) {
		const whole = count(await excerptOutline(db, { ...opts, mode: 'book' }));
		// Offered only when it adds something and goes in one request.
		if (whole.requests === 1 && whole.scenes > scenesRead.scenes) book = whole;
	}
	return {
		model: budget.model,
		scenes: scenesRead,
		...(book ? { book } : {}),
		confirm: scenesRead.estTokens > ENRICH_CONFIRM_TOKENS
	};
}
