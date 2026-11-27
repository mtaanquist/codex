import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../auth.ts';
import { embeddingIndexes, sceneChunks, scenes, stories } from '../../db/schema.ts';
import { errorFields, logEvent } from '../../log.ts';
import { tokensForChars } from '../context/budgets.ts';
import { jobSpendMeter } from '../job-spend.ts';
import { SpendCapError, spentFields } from '../spend.ts';
import { chunkHash, chunkScene } from './chunks.ts';
import { resolveEmbeddings } from './config.ts';
import {
	embed,
	EmbeddingsDisabledError,
	EMBED_BATCH_SIZE,
	type EmbedDeps,
	type EmbedResult
} from './embed.ts';

// The search index: each scene's passages embedded with the writer's own
// embeddings model, kept in scene_chunks. A writer turns it on per universe
// (embedding_indexes); the index then covers their own live stories there.
// Indexing only reads scenes. Trashed scenes, and stories muted for the
// Assistant, are left out.

export type IndexScope = { storyId: string } | { universeId: string };

// A first full index above this many tokens asks the writer first.
export const EMBED_CONFIRM_TOKENS = 50_000;

// Scenes read per query while indexing.
const SCENE_PAGE = 50;

// A scene is current when it has passages of the given model read at its
// present updated_at, or has no text and no passages.
const HAS_TEXT = sql.raw(`s.body_md ~ '[^[:space:]]'`);
function sceneStale(model: SQL): SQL {
	return sql`(
		(${HAS_TEXT} and not exists (
			select 1 from scene_chunks c
			where c.scene_id = s.id and c.model = ${model} and c.scene_updated_at = s.updated_at
		))
		or (not ${HAS_TEXT} and exists (select 1 from scene_chunks c where c.scene_id = s.id))
	)`;
}

// The writer's own live, unmuted stories, as `st`, in the scope.
function ownStories(userId: string, scope: IndexScope): SQL {
	const where =
		'storyId' in scope ? sql`st.id = ${scope.storyId}` : sql`st.universe_id = ${scope.universeId}`;
	return sql`st.owner_id = ${userId} and ${where}
		and st.deleted_at is null
		and exists (select 1 from universes u where u.id = st.universe_id and u.deleted_at is null)
		and coalesce(st.llm_config ->> 'enabled', '') <> 'false'`;
}

// The same, only where the writer has turned the index on.
const INDEX_ON = sql.raw(`exists (
	select 1 from embedding_indexes ei
	where ei.user_id = st.owner_id and ei.universe_id = st.universe_id
)`);
function indexedStories(userId: string, scope: IndexScope): SQL {
	return sql`${ownStories(userId, scope)} and ${INDEX_ON}`;
}

type StaleScene = { id: string; storyId: string; bodyMd: string; updatedAt: string };

// The next page of live scenes that need indexing, in id order after `after`.
// updatedAt is Postgres's own text, so writing it back loses no precision.
async function staleScenes(
	db: Database,
	userId: string,
	scope: IndexScope,
	model: string,
	after: string | null
): Promise<StaleScene[]> {
	const { rows } = await db.execute<{
		id: string;
		story_id: string;
		body_md: string;
		updated_at: string;
	}>(sql`
		select s.id, s.story_id, s.body_md, s.updated_at::text as updated_at
		from scenes s join stories st on st.id = s.story_id
		where ${indexedStories(userId, scope)}
			and s.deleted_at is null
			and ${sceneStale(sql`${model}`)}
			${after ? sql`and s.id > ${after}` : sql``}
		order by s.id
		limit ${SCENE_PAGE}
	`);
	return rows.map((r) => ({
		id: r.id,
		storyId: r.story_id,
		bodyMd: r.body_md,
		updatedAt: r.updated_at
	}));
}

// Drops the passages of the writer's trashed scenes in the scope.
async function dropTrashedChunks(db: Database, userId: string, scope: IndexScope): Promise<number> {
	const { rows } = await db.execute<{ scene_id: string }>(sql`
		delete from scene_chunks where scene_id in (
			select s.id from scenes s join stories st on st.id = s.story_id
			where ${indexedStories(userId, scope)} and s.deleted_at is not null
		)
		returning scene_id
	`);
	return new Set(rows.map((r) => r.scene_id)).size;
}

type Passage = { content: string; hash: string; vector?: number[] };

// Replaces a scene's passages with ones read at updatedAt. A run that read the
// scene earlier than the passages already stored leaves them alone, and a
// scene trashed or deleted meanwhile, or one whose index was turned off,
// gets none.
async function writeSceneChunks(
	db: Database,
	scene: StaleScene,
	passages: Passage[],
	model: string,
	dimensions: number
): Promise<boolean> {
	return await db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`scene-chunks:${scene.id}`}, 0))`
		);
		const { rows } = await tx.execute<{ newer: boolean; live: boolean }>(sql`
			select
				exists (
					select 1 from scene_chunks
					where scene_id = ${scene.id} and scene_updated_at > ${scene.updatedAt}::timestamptz
				) as newer,
				exists (
					select 1 from scenes s join stories st on st.id = s.story_id
					where s.id = ${scene.id} and s.deleted_at is null and ${INDEX_ON}
				) as live
		`);
		if (rows[0]?.newer || !rows[0]?.live) return false;
		await tx.delete(sceneChunks).where(eq(sceneChunks.sceneId, scene.id));
		if (passages.length > 0) {
			await tx.insert(sceneChunks).values(
				passages.map((p, chunkIndex) => ({
					sceneId: scene.id,
					chunkIndex,
					content: p.content,
					contentHash: p.hash,
					model,
					dimensions,
					embedding: p.vector!,
					sceneUpdatedAt: sql`${scene.updatedAt}::timestamptz`
				}))
			);
		}
		return true;
	});
}

export type IndexResult = {
	// The embeddings model the run used.
	model: string;
	// Scenes brought up to date, and passages embedded or kept from before.
	scenes: number;
	embedded: number;
	reused: number;
	// Trashed or emptied scenes whose passages were dropped.
	removed: number;
	// The run reached the end of the scope.
	complete: boolean;
	disabled?: true;
	capped?: true;
	aborted?: true;
	// The endpoint's error, when it failed.
	error?: string;
	spentUsd?: number;
};

type Work = { scene: StaleScene; passages: Passage[]; missing: string[] };

// Brings the scope's scenes up to date: passages whose text is unchanged keep
// their vector, the rest are embedded, a batch of about 64 at a time across
// scenes. Vectors of another model or size are never kept. Stops at the spend
// cap, a Stop, or an endpoint that keeps failing; what it finished stays.
export async function indexScenes(
	db: Database,
	opts: {
		userId: string;
		scope: IndexScope;
		jobId?: string;
		signal?: AbortSignal;
		deps?: EmbedDeps;
	}
): Promise<IndexResult> {
	const { userId, scope } = opts;
	const config = await resolveEmbeddings(db, userId);
	const result: IndexResult = {
		model: config.model,
		scenes: 0,
		embedded: 0,
		reused: 0,
		removed: 0,
		complete: false
	};
	if (!config.ready) return { ...result, disabled: true };
	const meter = await jobSpendMeter(db, { userId, jobId: opts.jobId });
	result.removed += await dropTrashedChunks(db, userId, scope);

	const plan = async (scene: StaleScene): Promise<Work> => {
		const texts = chunkScene(scene.bodyMd);
		const stored = await db
			.select({
				hash: sceneChunks.contentHash,
				model: sceneChunks.model,
				dimensions: sceneChunks.dimensions,
				embedding: sceneChunks.embedding
			})
			.from(sceneChunks)
			.where(eq(sceneChunks.sceneId, scene.id));
		const kept = new Map(
			stored
				.filter(
					(c) =>
						c.model === config.model &&
						(config.dimensions === undefined || c.dimensions === config.dimensions)
				)
				.map((c) => [c.hash, c.embedding])
		);
		const passages = texts.map((content) => {
			const hash = chunkHash(content);
			return { content, hash, vector: kept.get(hash) };
		});
		const missing = [...new Set(passages.filter((p) => !p.vector).map((p) => p.content))];
		return { scene, passages, missing };
	};

	const finish = async (work: Work, embedded?: EmbedResult, offset = 0) => {
		const vectors = new Map<string, number[]>();
		work.missing.forEach((text, i) => vectors.set(text, embedded!.vectors[offset + i]));
		const passages = work.passages.map((p) => ({
			...p,
			vector: p.vector ?? vectors.get(p.content)
		}));
		const dimensions = embedded?.dimensions ?? passages[0]?.vector?.length ?? 0;
		// A kept vector of another size means the server changed under the same
		// model name: embed the whole scene again on the next pass.
		if (passages.some((p) => p.vector!.length !== dimensions)) {
			await db.delete(sceneChunks).where(eq(sceneChunks.sceneId, work.scene.id));
			return;
		}
		if (await writeSceneChunks(db, work.scene, passages, config.model, dimensions)) {
			if (passages.length === 0) result.removed += 1;
			else result.scenes += 1;
			result.embedded += work.missing.length;
			result.reused += passages.length - work.missing.length;
		}
	};

	// Embeds a group of scenes in one go and stores each.
	const flush = async (group: Work[]) => {
		const texts = group.flatMap((w) => w.missing);
		const storyId = group[0].scene.storyId;
		const embedded = await embed(
			db,
			userId,
			texts,
			{ meter, storyId, signal: opts.signal },
			opts.deps
		);
		let offset = 0;
		for (const work of group) {
			await finish(work, embedded, offset);
			offset += work.missing.length;
		}
	};

	try {
		let after: string | null = null;
		for (;;) {
			const page = await staleScenes(db, userId, scope, config.model, after);
			if (page.length === 0) break;
			after = page[page.length - 1].id;
			// A group is one story's scenes (embed checks one story's mute) and
			// at most a batch of texts, unless one scene alone is more.
			let group: Work[] = [];
			let size = 0;
			for (const scene of page) {
				if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('Stopped.');
				const work = await plan(scene);
				if (work.missing.length === 0) {
					await finish(work);
					continue;
				}
				const sameStory = group.length === 0 || group[0].scene.storyId === scene.storyId;
				if (group.length > 0 && (!sameStory || size + work.missing.length > EMBED_BATCH_SIZE)) {
					await flush(group);
					group = [];
					size = 0;
				}
				group.push(work);
				size += work.missing.length;
			}
			if (group.length > 0) await flush(group);
		}
		result.complete = true;
	} catch (err) {
		if (err instanceof EmbeddingsDisabledError) result.disabled = true;
		else if (err instanceof SpendCapError) {
			result.capped = true;
			result.spentUsd = spentFields(meter).spentUsd;
		} else if (opts.signal?.aborted) result.aborted = true;
		else {
			result.error = err instanceof Error ? err.message : 'The embeddings request failed.';
			logEvent('warn', 'embeddings.index_failed', { userId, ...errorFields(err) });
		}
	} finally {
		await meter.flush();
	}
	return result;
}

// The writer's index for a universe, if they turned it on: the model its last
// full index finished with, if any.
export async function embeddingIndexFor(
	db: Database,
	userId: string,
	universeId: string
): Promise<{ model: string | null; completedAt: Date | null } | null> {
	const [row] = await db
		.select({ model: embeddingIndexes.model, completedAt: embeddingIndexes.completedAt })
		.from(embeddingIndexes)
		.where(and(eq(embeddingIndexes.userId, userId), eq(embeddingIndexes.universeId, universeId)));
	return row ?? null;
}

// Turns the index on for a universe. Its first full index is the caller's to
// queue.
export async function enableEmbeddingIndex(
	db: Database,
	userId: string,
	universeId: string
): Promise<void> {
	await db.insert(embeddingIndexes).values({ userId, universeId }).onConflictDoNothing();
}

// Records a full index that reached the end with this model, so the worker
// keeps it current from now on.
export async function completeEmbeddingIndex(
	db: Database,
	userId: string,
	universeId: string,
	model: string
): Promise<void> {
	await db
		.update(embeddingIndexes)
		.set({ model, completedAt: sql`now()` })
		.where(and(eq(embeddingIndexes.userId, userId), eq(embeddingIndexes.universeId, universeId)));
}

// Turns the index off for a universe and drops its passages.
export async function removeEmbeddingIndex(
	db: Database,
	userId: string,
	universeId: string
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.delete(embeddingIndexes)
			.where(and(eq(embeddingIndexes.userId, userId), eq(embeddingIndexes.universeId, universeId)));
		const own = tx
			.select({ id: scenes.id })
			.from(scenes)
			.innerJoin(stories, eq(stories.id, scenes.storyId))
			.where(and(eq(stories.ownerId, userId), eq(stories.universeId, universeId)));
		await tx.delete(sceneChunks).where(inArray(sceneChunks.sceneId, own));
	});
}

// The SQL test for an account whose embeddings may run: the Assistant on, and
// embeddings on with a model. `usr` is the users row.
const EMBEDDINGS_ON = sql.raw(`(usr.llm_config ->> 'enabled') = 'true'
	and (usr.llm_config -> 'embeddings' ->> 'enabled') = 'true'
	and coalesce(usr.llm_config -> 'embeddings' ->> 'endpoint', '') <> ''
	and coalesce(usr.llm_config -> 'embeddings' ->> 'model', '') <> ''`);

// Whose index keeps this story current, if anyone's: its owner, when the
// story's universe has a finished index for the model they use now.
export async function storyIndexOwner(db: Database, storyId: string): Promise<string | null> {
	const { rows } = await db.execute<{ owner_id: string }>(sql`
		select st.owner_id from stories st
		join embedding_indexes ei on ei.user_id = st.owner_id and ei.universe_id = st.universe_id
		join users usr on usr.id = st.owner_id
		where st.id = ${storyId} and ei.completed_at is not null
			and ei.model = usr.llm_config -> 'embeddings' ->> 'model'
			and ${EMBEDDINGS_ON}
	`);
	return rows[0]?.owner_id ?? null;
}

// Stories whose finished index has fallen behind (a save whose job was
// dropped, a scene restored or trashed), for the worker's sweep.
export async function storiesBehindIndex(
	db: Database,
	limit = 100
): Promise<{ userId: string; storyId: string }[]> {
	const { rows } = await db.execute<{ owner_id: string; story_id: string }>(sql`
		select st.owner_id, st.id as story_id
		from embedding_indexes ei
		join users usr on usr.id = ei.user_id
		join stories st on st.owner_id = ei.user_id and st.universe_id = ei.universe_id
		where ei.completed_at is not null
			and ei.model = usr.llm_config -> 'embeddings' ->> 'model'
			and ${EMBEDDINGS_ON}
			and st.deleted_at is null
			and exists (select 1 from universes u where u.id = st.universe_id and u.deleted_at is null)
			and coalesce(st.llm_config ->> 'enabled', '') <> 'false'
			and exists (
				select 1 from scenes s where s.story_id = st.id and (
					(s.deleted_at is null and ${sceneStale(sql.raw('ei.model'))})
					or (s.deleted_at is not null and exists (select 1 from scene_chunks c where c.scene_id = s.id))
				)
			)
		limit ${limit}
	`);
	return rows.map((r) => ({ userId: r.owner_id, storyId: r.story_id }));
}

export type IndexEstimate = {
	model: string;
	// Scenes the index would read, and roughly the tokens that sends.
	scenes: number;
	estTokens: number;
	// Only when the writer entered a price for the model.
	estCostUsd?: number;
	// Large enough to ask the writer first.
	confirm: boolean;
};

// What indexing the writer's stories in a universe would send now, counted
// without sending anything. Every passage of a scene that needs indexing is
// counted, so it is an upper bound.
export async function estimateEmbeddingIndex(
	db: Database,
	userId: string,
	universeId: string
): Promise<IndexEstimate> {
	const config = await resolveEmbeddings(db, userId);
	const { rows } = await db.execute<{ scenes: number; chars: number }>(sql`
		select count(*)::int as scenes, coalesce(sum(length(s.body_md)), 0)::bigint as chars
		from scenes s join stories st on st.id = s.story_id
		where ${ownStories(userId, { universeId })}
			and s.deleted_at is null and ${HAS_TEXT}
			and ${sceneStale(sql`${config.model}`)}
	`);
	const scenesToRead = Number(rows[0]?.scenes ?? 0);
	const estTokens = tokensForChars(Number(rows[0]?.chars ?? 0));
	return {
		model: config.model,
		scenes: scenesToRead,
		estTokens,
		...(config.price ? { estCostUsd: estTokens * config.price.prompt } : {}),
		confirm: estTokens > EMBED_CONFIRM_TOKENS
	};
}

export type IndexStatus = {
	universeId: string;
	name: string;
	// 'off': not turned on. 'partial': turned on, its first full index not
	// finished (stopped, or still running). 'current': kept current
	// automatically. 'model-changed': indexed with another model, so it needs
	// a full index again.
	state: 'off' | 'partial' | 'current' | 'model-changed';
	// Scenes with text in the writer's stories there, and how many of them are
	// indexed as they stand now with the current model.
	scenes: number;
	indexed: number;
};

// Every universe the writer has a live story in, with how far its index is.
export async function embeddingIndexStatus(db: Database, userId: string): Promise<IndexStatus[]> {
	const config = await resolveEmbeddings(db, userId);
	const { rows } = await db.execute<{
		universe_id: string;
		name: string;
		enabled: boolean;
		model: string | null;
		completed: boolean;
		scenes: number;
		indexed: number;
	}>(sql`
		select u.id as universe_id, u.name,
			ei.user_id is not null as enabled, ei.model, ei.completed_at is not null as completed,
			count(s.id)::int as scenes,
			count(s.id) filter (where not ${sceneStale(sql`${config.model}`)})::int as indexed
		from universes u
		join stories st on st.universe_id = u.id
		left join scenes s on s.story_id = st.id and s.deleted_at is null and ${HAS_TEXT}
		left join embedding_indexes ei on ei.user_id = ${userId} and ei.universe_id = u.id
		where st.owner_id = ${userId} and st.deleted_at is null and u.deleted_at is null
			and coalesce(st.llm_config ->> 'enabled', '') <> 'false'
		group by u.id, u.name, u.standalone, ei.user_id, ei.model, ei.completed_at
		order by u.standalone, lower(u.name)
	`);
	return rows.map((r) => ({
		universeId: r.universe_id,
		name: r.name,
		state: !r.enabled
			? 'off'
			: !r.completed
				? 'partial'
				: r.model === config.model
					? 'current'
					: 'model-changed',
		scenes: r.scenes,
		indexed: r.indexed
	}));
}

export type NearestChunk = {
	sceneId: string;
	storyId: string;
	universeId: string;
	chunkIndex: number;
	// The passage as it was embedded. The scene may have changed since.
	content: string;
	sceneTitle: string | null;
	storyTitle: string;
	// Cosine distance: 0 is the same direction, 2 the opposite.
	distance: number;
};

// The passages closest in meaning to a query vector, within the writer's own
// live, unmuted stories in a universe (or one story) they turned the index on
// for. query is what embed() returned for the query text: only passages of
// that model and size are compared. The search is exact, which is fast at the
// size of one writer's universe.
export async function nearestChunks(
	db: Database,
	userId: string,
	scope: IndexScope,
	query: { model: string; vector: number[] },
	limit = 10
): Promise<NearestChunk[]> {
	if (query.vector.length === 0) return [];
	const take = Math.max(1, Math.min(100, Math.floor(limit)));
	const vector = JSON.stringify(query.vector);
	const { rows } = await db.execute<{
		scene_id: string;
		story_id: string;
		universe_id: string;
		chunk_index: number;
		content: string;
		scene_title: string | null;
		story_title: string;
		distance: number;
	}>(sql`
		select c.scene_id, s.story_id, st.universe_id, c.chunk_index, c.content,
			s.title as scene_title, st.title as story_title,
			(c.embedding <=> ${vector}::vector) as distance
		from scene_chunks c
		join scenes s on s.id = c.scene_id
		join stories st on st.id = s.story_id
		where ${indexedStories(userId, scope)}
			and s.deleted_at is null
			and c.model = ${query.model} and c.dimensions = ${query.vector.length}
		order by distance, c.scene_id, c.chunk_index
		limit ${take}
	`);
	return rows.map((r) => ({
		sceneId: r.scene_id,
		storyId: r.story_id,
		universeId: r.universe_id,
		chunkIndex: r.chunk_index,
		content: r.content,
		sceneTitle: r.scene_title,
		storyTitle: r.story_title,
		distance: Number(r.distance)
	}));
}
