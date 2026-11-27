import { and, eq, inArray } from 'drizzle-orm';
import type { MeaningResult } from '#lib/wire-types';
import type { Database } from './auth.ts';
import { stories } from './db/schema.ts';
import { embed, resolveEmbeddings, type EmbedDeps } from './llm/embeddings/index.ts';
import { embeddingIndexFor, nearestChunks } from './llm/embeddings/scene-index.ts';

// Search by meaning: the writer describes a moment, it is embedded with their
// own embeddings model, and the nearest passages in their indexed stories in
// one universe come back, one per scene.

export type { MeaningResult } from '#lib/wire-types';

// Longer than any description of a scene needs to be.
export const MEANING_QUERY_MAX = 500;
// Scenes listed, and passages read to find them: a scene can hold several of
// the nearest passages, and only its best one is shown.
const SCENES = 10;
const PASSAGES = 40;
const PASSAGE_CHARS = 320;

// Whether the writer can search this universe by meaning: embeddings are
// ready and the universe has a finished index on their current model. A
// partial index, or one made with another model, does not count.
export async function meaningSearchReady(
	db: Database,
	userId: string,
	universeId: string
): Promise<boolean> {
	const config = await resolveEmbeddings(db, userId);
	if (!config.ready) return false;
	const index = await embeddingIndexFor(db, userId, universeId);
	return !!index?.completedAt && index.model === config.model;
}

// The passage as a result line: white space folded, cut at a word near
// PASSAGE_CHARS.
export function passageSnippet(content: string): string {
	const flat = content.replace(/\s+/g, ' ').trim();
	if (flat.length <= PASSAGE_CHARS) return flat;
	const cut = flat.slice(0, PASSAGE_CHARS);
	const space = cut.lastIndexOf(' ');
	return `${(space > PASSAGE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

// The caller checks meaningSearchReady first. Throws what embed throws:
// EmbeddingsDisabledError, SpendCapError, or the endpoint's own error.
export async function searchByMeaning(
	db: Database,
	userId: string,
	universeId: string,
	query: string,
	deps?: EmbedDeps
): Promise<MeaningResult[]> {
	const text = query.trim();
	if (!text) return [];
	const { model, vectors } = await embed(db, userId, [text], {}, deps);
	const chunks = await nearestChunks(
		db,
		userId,
		{ universeId },
		{ model, vector: vectors[0] },
		PASSAGES
	);
	const best = new Map<string, (typeof chunks)[number]>();
	for (const chunk of chunks) {
		if (!best.has(chunk.sceneId)) best.set(chunk.sceneId, chunk);
		if (best.size === SCENES) break;
	}
	if (best.size === 0) return [];
	const storyIds = [...new Set([...best.values()].map((c) => c.storyId))];
	const slugs = new Map(
		(
			await db
				.select({ id: stories.id, slug: stories.slug })
				.from(stories)
				.where(and(inArray(stories.id, storyIds), eq(stories.ownerId, userId)))
		).map((row) => [row.id, row.slug])
	);
	return [...best.values()].flatMap((chunk) => {
		const slug = slugs.get(chunk.storyId);
		if (!slug) return [];
		return [
			{
				sceneId: chunk.sceneId,
				sceneTitle: chunk.sceneTitle,
				storyTitle: chunk.storyTitle,
				passage: passageSnippet(chunk.content),
				href: `/stories/${slug}?scene=${chunk.sceneId}`
			}
		];
	});
}
