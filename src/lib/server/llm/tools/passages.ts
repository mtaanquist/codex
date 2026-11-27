import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Database } from '../../auth.ts';
import { embeddingIndexes, universes } from '../../db/schema.ts';
import { embeddingsView } from '../embeddings/config.ts';
import { embed, EmbeddingsDisabledError, type EmbedDeps } from '../embeddings/embed.ts';
import { nearestChunks, type IndexScope } from '../embeddings/scene-index.ts';
import { SpendCapError, type SpendMeter } from '../spend.ts';

// The search_passages tool: the passages of the writer's own stories closest
// in meaning to a query, from the search index (scene_chunks). It is offered
// only where that index can answer: embeddings ready, and a universe whose
// full index finished on the current model.

export const PASSAGE_SEARCH_TOOL = 'search_passages';

export const DEFAULT_PASSAGES = 8;
export const MAX_PASSAGES = 20;
// A passage is at most MAX_CHUNK_CHARS (1,500) when indexed; this is the
// backstop should that ever grow.
export const MAX_PASSAGE_CHARS = 1500;
export const MAX_QUERY_CHARS = 1000;

export const NO_PASSAGE_INDEX =
	'Passage search is not available in this universe: its search index is not built. Use search_text instead.';
export const PASSAGES_OFF =
	'Passage search is turned off or not set up on this account. Use search_text instead.';
export const PASSAGES_CAPPED =
	'Passage search was not run: it could take this run past your spend cap.';

// Whether passage search can answer for the writer: in one universe, or in
// any of theirs when none is given (an outside app picks the universe per
// call).
export async function passageSearchReady(
	db: Database,
	userId: string,
	universeId?: string
): Promise<boolean> {
	// The key-free view: a key that no longer decrypts must not break every
	// turn and every MCP request; embed() reports it when a search is run.
	const config = await embeddingsView(db, userId);
	if (!config.ready) return false;
	const [row] = await db
		.select({ universeId: embeddingIndexes.universeId })
		.from(embeddingIndexes)
		.innerJoin(universes, eq(universes.id, embeddingIndexes.universeId))
		.where(
			and(
				eq(embeddingIndexes.userId, userId),
				universeId ? eq(embeddingIndexes.universeId, universeId) : undefined,
				isNotNull(embeddingIndexes.completedAt),
				eq(embeddingIndexes.model, config.model),
				eq(universes.ownerId, userId),
				isNull(universes.deletedAt)
			)
		)
		.limit(1);
	return Boolean(row);
}

export type PassageSearchContext = {
	db: Database;
	userId: string;
	// The universe, or one story in it when the reads are confined to it.
	scope: IndexScope;
	universeId: string;
	meter?: SpendMeter;
	signal?: AbortSignal;
	deps?: EmbedDeps;
};

function clampLimit(value: unknown): number {
	const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : NaN;
	if (Number.isNaN(n)) return DEFAULT_PASSAGES;
	return Math.max(1, Math.min(MAX_PASSAGES, n));
}

export async function searchPassages(
	ctx: PassageSearchContext,
	query: string,
	limit: unknown
): Promise<string> {
	const text = query.trim();
	if (!text) return 'Provide a search query.';
	if (text.length > MAX_QUERY_CHARS) {
		return `The query is too long. Keep it under ${MAX_QUERY_CHARS} characters.`;
	}
	// Checked on every call: the tool list an app or a turn was given may be
	// older than the index, and an app names its universe per call.
	if (!(await passageSearchReady(ctx.db, ctx.userId, ctx.universeId))) return NO_PASSAGE_INDEX;
	let vector: { model: string; vector: number[] };
	try {
		// No storyId: the query is the caller's text, not a story's.
		const result = await embed(
			ctx.db,
			ctx.userId,
			[text],
			{ meter: ctx.meter, signal: ctx.signal },
			ctx.deps
		);
		vector = { model: result.model, vector: result.vectors[0] ?? [] };
	} catch (err) {
		if (err instanceof EmbeddingsDisabledError) return PASSAGES_OFF;
		if (err instanceof SpendCapError) return PASSAGES_CAPPED;
		throw err;
	}
	const rows = await nearestChunks(ctx.db, ctx.userId, ctx.scope, vector, clampLimit(limit));
	return JSON.stringify({
		passages: rows.map((row) => ({
			sceneId: row.sceneId,
			sceneTitle: row.sceneTitle,
			storyId: row.storyId,
			storyTitle: row.storyTitle,
			text: row.content.slice(0, MAX_PASSAGE_CHARS),
			// Cosine similarity: 1 is the closest.
			similarity: Math.round((1 - row.distance) * 1000) / 1000
		}))
	});
}
