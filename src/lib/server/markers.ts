import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { markerRemaps, sceneMarkers, scenes, stories } from './db/schema.ts';
import { ownedScene } from './scene-access.ts';
import { storyIsLive } from './universe-scope.ts';
import { findTodoLines } from '#lib/todo-markers';
import { toLf } from '#lib/line-endings';
import { textHash } from '#lib/text-hash';
import { BACKGROUND_DIFF_BUDGET, createAnchorMapper, SAVE_DIFF_BUDGET } from '../review-anchor.ts';
import type { ActionFailure } from './action-result.ts';

// A selection turned into a checkable marker. Anchors are clamped to the
// scene body so a stale client cannot write ranges past the end. With
// baseHash (the fingerprint of the text the editor counted the anchors into)
// the marker is refused when the scene holds another text by now, and the
// refusal carries that text; the scene row is locked while checking, so a
// save cannot land in between.
export async function createMarker(
	db: Database,
	userId: string,
	sceneId: string,
	anchorStart: number,
	anchorEnd: number,
	bodyMd?: string,
	baseHash?: string
): Promise<
	{ ok: true; id: string } | (ActionFailure & { scene?: { bodyMd: string; title: string | null } })
> {
	return await db.transaction(async (tx) => {
		const scene = await ownedScene(tx, userId, sceneId);
		if (!scene) return { ok: false, code: 'not_found', reason: 'That scene does not exist.' };
		const [locked] = await tx
			.select({ bodyMd: scenes.bodyMd, title: scenes.title })
			.from(scenes)
			.where(eq(scenes.id, sceneId))
			.for('share');
		if (!locked) return { ok: false, code: 'not_found', reason: 'That scene does not exist.' };
		if (baseHash !== undefined && textHash(locked.bodyMd) !== baseHash) {
			return {
				ok: false,
				code: 'conflict',
				reason: 'The scene text changed. Select the words and mark them again.',
				scene: { bodyMd: locked.bodyMd, title: locked.title }
			};
		}
		const length = locked.bodyMd.length;
		const start = Math.max(0, Math.min(anchorStart, length));
		const end = Math.max(start, Math.min(anchorEnd, length));
		if (end === start) return { ok: false, code: 'invalid', reason: 'Select some text to mark.' };
		const [marker] = await tx
			.insert(sceneMarkers)
			.values({
				sceneId,
				ownerId: userId,
				anchorStart: start,
				anchorEnd: end,
				bodyMd: bodyMd?.trim() || null
			})
			.returning({ id: sceneMarkers.id });
		return { ok: true, id: marker.id };
	});
}

// Markers own their scene by id; this keeps a marker in a trashed universe
// from being changed by id.
function inLiveScene(db: Database) {
	return inArray(
		sceneMarkers.sceneId,
		db
			.select({ id: scenes.id })
			.from(scenes)
			.innerJoin(stories, eq(scenes.storyId, stories.id))
			.where(storyIsLive())
	);
}

export async function setMarkerResolved(
	db: Database,
	userId: string,
	markerId: string,
	resolved: boolean
): Promise<boolean> {
	const updated = await db
		.update(sceneMarkers)
		.set({ resolvedAt: resolved ? sql`now()` : null })
		.where(and(eq(sceneMarkers.id, markerId), eq(sceneMarkers.ownerId, userId), inLiveScene(db)))
		.returning({ id: sceneMarkers.id });
	return updated.length > 0;
}

export async function deleteMarker(
	db: Database,
	userId: string,
	markerId: string
): Promise<boolean> {
	const deleted = await db
		.delete(sceneMarkers)
		.where(and(eq(sceneMarkers.id, markerId), eq(sceneMarkers.ownerId, userId), inLiveScene(db)))
		.returning({ id: sceneMarkers.id });
	return deleted.length > 0;
}

// The editor maps anchors through edits; the autosave persists where they
// landed. One UPDATE over unnested arrays; the scene_id condition keeps
// the write to the scene's own markers. Anchors are clamped to the body
// length (as createMarker does), so a stale or crafted client cannot store
// ranges past the end or inverted.
export async function updateMarkerAnchors(
	db: Database,
	sceneId: string,
	anchors: { id: string; anchorStart: number; anchorEnd: number }[],
	bodyLength: number
): Promise<void> {
	if (anchors.length === 0) return;
	anchors = anchors.map((anchor) => {
		const start = Math.max(0, Math.min(anchor.anchorStart, bodyLength));
		const end = Math.max(start, Math.min(anchor.anchorEnd, bodyLength));
		return { id: anchor.id, anchorStart: start, anchorEnd: end };
	});
	// array[...] constructors, since a bare array parameter binds as a
	// record rather than a Postgres array.
	const column = (values: (string | number)[]) =>
		sql.join(
			values.map((value) => sql`${value}`),
			sql`, `
		);
	await db.execute(sql`
		update scene_markers set
			anchor_start = v.anchor_start,
			anchor_end = v.anchor_end
		from (
			select
				unnest(array[${column(anchors.map((anchor) => anchor.id))}]::uuid[]) as id,
				unnest(array[${column(anchors.map((anchor) => anchor.anchorStart))}]::int[]) as anchor_start,
				unnest(array[${column(anchors.map((anchor) => anchor.anchorEnd))}]::int[]) as anchor_end
		) as v
		where scene_markers.id = v.id and scene_markers.scene_id = ${sceneId}
	`);
	await forgetPendingRemaps(
		db,
		sceneId,
		anchors.map((anchor) => anchor.id)
	);
}

// A marker that was given a new anchor, or detached by a later save, is no
// longer waiting on a remap row made earlier: that row's text is not what
// its anchor counts into any more.
async function forgetPendingRemaps(db: Database, sceneId: string, ids: string[]) {
	if (ids.length === 0) return;
	await db.execute(sql`
		update marker_remaps set markers = coalesce((
			select jsonb_agg(m) from jsonb_array_elements(marker_remaps.markers) as m
			where not (m->>'id' = any(array[${sql.join(
				ids.map((id) => sql`${id}`),
				sql`, `
			)}]::text[]))
		), '[]'::jsonb)
		where scene_id = ${sceneId}
	`);
}

// For a body rewrite that does not come from the Write editor (a review
// save, an accepted suggestion, a restore): map every anchored marker
// through the old-to-new comparison, so it keeps pointing at the same words.
// A marker whose start or end text is gone, or whose range is left empty,
// loses its anchor rather than pointing at whatever now sits at its old
// offsets. Run inside the transaction that writes the body. Anchors count
// \r\n as one character, as the editor does, so the comparison runs on that
// text.
//
// The comparison runs under SAVE_DIFF_BUDGET, in one go. A marker in a
// stretch that would cost more to compare loses its anchor for now, and a
// marker_remaps row keeps the old text and its anchor for the worker's sweep
// (remapPendingMarkers), which maps it again without that limit. Each end of a
// marker is stored only where it rests on text both versions share (see
// SUPPORT in review-anchor.ts); otherwise the marker loses its anchor, as one
// whose words were deleted does.
//
// `except` names markers whose new anchors the caller writes itself (the
// Write editor's own); every other anchored marker is mapped here.
export async function remapMarkerAnchors(
	db: Database,
	sceneId: string,
	storedOld: string,
	storedNew: string,
	except: string[] = []
): Promise<void> {
	const oldBody = toLf(storedOld);
	const newBody = toLf(storedNew);
	if (oldBody === newBody) return;
	const markers = await db
		.select({
			id: sceneMarkers.id,
			anchorStart: sceneMarkers.anchorStart,
			anchorEnd: sceneMarkers.anchorEnd
		})
		.from(sceneMarkers)
		.where(eq(sceneMarkers.sceneId, sceneId));
	const mapper = createAnchorMapper(SAVE_DIFF_BUDGET);
	const skip = new Set(except);
	const anchored = markers.flatMap(({ id, anchorStart: start, anchorEnd: end }) =>
		start === null || end === null || skip.has(id) ? [] : [{ id, start, end }]
	);
	const moved: { id: string; anchorStart: number; anchorEnd: number }[] = [];
	const lost: string[] = [];
	const unchecked: { id: string; start: number; end: number }[] = [];
	for (const marker of anchored) {
		// Each end maps on its own, so an edit at the edge of the marked text
		// stretches or shrinks the range instead of losing it.
		const now = mapper.ends(oldBody, newBody, marker.start, marker.end);
		if (now) moved.push({ id: marker.id, anchorStart: now.start, anchorEnd: now.end });
		else {
			lost.push(marker.id);
			if (mapper.unchecked(oldBody, newBody, marker.start, marker.end)) unchecked.push(marker);
		}
	}
	await updateMarkerAnchors(db, sceneId, moved, newBody.length);
	if (lost.length > 0) {
		await db
			.update(sceneMarkers)
			.set({ anchorStart: null, anchorEnd: null })
			.where(and(eq(sceneMarkers.sceneId, sceneId), inArray(sceneMarkers.id, lost)));
		await forgetPendingRemaps(db, sceneId, lost);
	}
	if (unchecked.length > 0) {
		await db.insert(markerRemaps).values({ sceneId, baseBody: oldBody, markers: unchecked });
	}
}

// The worker's sweep over markers a save detached because comparing their
// stretch cost more than the save's budget. Each row is mapped from the text
// its anchors were made on to the scene's text as it now stands, under
// BACKGROUND_DIFF_BUDGET, outside any lock. The write then happens under the
// scene's row lock, only if the text is still the one that was mapped onto
// (otherwise the row waits for the next sweep), and only to markers that are
// still in that scene and still detached: one the writer anchored again in
// the meantime, deleted or moved to another scene by a split or merge is
// left alone. Deleting the row in the same transaction makes a repeat a no
// op. A marker that still cannot be placed stays detached. Never touches the
// scene's text. Returns how many rows it finished.
export async function remapPendingMarkers(db: Database, limit = 20): Promise<number> {
	const rows = await db
		.select({ id: markerRemaps.id, sceneId: markerRemaps.sceneId })
		.from(markerRemaps)
		.orderBy(asc(markerRemaps.createdAt))
		.limit(limit);
	let done = 0;
	for (const { id } of rows) {
		const [row] = await db
			.select({
				sceneId: markerRemaps.sceneId,
				baseBody: markerRemaps.baseBody,
				markers: markerRemaps.markers,
				bodyMd: scenes.bodyMd
			})
			.from(markerRemaps)
			.innerJoin(scenes, eq(markerRemaps.sceneId, scenes.id))
			.where(eq(markerRemaps.id, id));
		if (!row) continue;
		const mapped = row.bodyMd;
		const body = toLf(mapped);
		const mapper = createAnchorMapper(BACKGROUND_DIFF_BUDGET);
		const placed = row.markers.flatMap(({ id, start, end }) => {
			const now = mapper.ends(row.baseBody, body, start, end);
			return now ? [{ id, anchorStart: now.start, anchorEnd: now.end }] : [];
		});
		const finished = await db.transaction(async (tx) => {
			const [scene] = await tx
				.select({ bodyMd: scenes.bodyMd })
				.from(scenes)
				.where(eq(scenes.id, row.sceneId))
				.for('update');
			if (!scene || scene.bodyMd !== mapped) return false;
			for (const marker of placed) {
				const end = Math.min(marker.anchorEnd, body.length);
				const start = Math.min(marker.anchorStart, end);
				await tx
					.update(sceneMarkers)
					.set({ anchorStart: start, anchorEnd: end })
					.where(
						and(
							eq(sceneMarkers.id, marker.id),
							eq(sceneMarkers.sceneId, row.sceneId),
							isNull(sceneMarkers.anchorStart),
							isNull(sceneMarkers.anchorEnd)
						)
					);
			}
			await tx.delete(markerRemaps).where(eq(markerRemaps.id, id));
			return true;
		});
		if (finished) done++;
	}
	return done;
}

// Unresolved markers across a story, for the continuous view's stitched
// editors, grouped by scene.
export async function listStoryMarkersByScene(db: Database, storyId: string) {
	const rows = await db
		.select({
			id: sceneMarkers.id,
			sceneId: sceneMarkers.sceneId,
			anchorStart: sceneMarkers.anchorStart,
			anchorEnd: sceneMarkers.anchorEnd
		})
		.from(sceneMarkers)
		.innerJoin(scenes, eq(sceneMarkers.sceneId, scenes.id))
		.where(and(eq(scenes.storyId, storyId), isNull(sceneMarkers.resolvedAt)))
		.orderBy(asc(sceneMarkers.anchorStart));
	const byScene: Record<
		string,
		{ id: string; anchorStart: number | null; anchorEnd: number | null }[]
	> = {};
	for (const row of rows) {
		(byScene[row.sceneId] ??= []).push({
			id: row.id,
			anchorStart: row.anchorStart,
			anchorEnd: row.anchorEnd
		});
	}
	return byScene;
}

// Unresolved markers for one scene, for the editor's highlights.
export async function listSceneMarkers(db: Database, sceneId: string) {
	return await db
		.select({
			id: sceneMarkers.id,
			anchorStart: sceneMarkers.anchorStart,
			anchorEnd: sceneMarkers.anchorEnd,
			bodyMd: sceneMarkers.bodyMd
		})
		.from(sceneMarkers)
		.where(and(eq(sceneMarkers.sceneId, sceneId), isNull(sceneMarkers.resolvedAt)))
		.orderBy(asc(sceneMarkers.anchorStart));
}

// The open scene's markers with the fingerprint of the text their anchors
// count into, read in one snapshot so a save landing between the two reads
// cannot pair anchors with another text. The editor maps them through only
// the edits it made after that text (see unsavedChanges in editor-markers).
export async function readSceneMarkers(db: Database, sceneId: string) {
	return await db.transaction(
		async (tx) => {
			const markers = await listSceneMarkers(tx, sceneId);
			const [scene] = await tx
				.select({ bodyMd: scenes.bodyMd })
				.from(scenes)
				.where(eq(scenes.id, sceneId));
			return { markers, version: scene ? textHash(scene.bodyMd) : null };
		},
		{ isolationLevel: 'repeatable read', accessMode: 'read only' }
	);
}

// The same for the continuous view: each scene with markers, its markers and
// the fingerprint of its text.
export async function readStoryMarkers(db: Database, storyId: string) {
	return await db.transaction(
		async (tx) => {
			const byScene = await listStoryMarkersByScene(tx, storyId);
			const ids = Object.keys(byScene);
			const bodies = ids.length
				? await tx
						.select({ id: scenes.id, bodyMd: scenes.bodyMd })
						.from(scenes)
						.where(inArray(scenes.id, ids))
				: [];
			const versions = new Map(bodies.map((scene) => [scene.id, textHash(scene.bodyMd)]));
			return Object.fromEntries(
				ids.map((id) => [id, { markers: byScene[id], version: versions.get(id) ?? null }])
			);
		},
		{ isolationLevel: 'repeatable read', accessMode: 'read only' }
	);
}

export type StoryTodo = {
	sceneId: string;
	sceneTitle: string | null;
	// Structured markers carry an id and can be checked off; text TODOs
	// carry null and resolve by deleting the line.
	markerId: string | null;
	text: string;
};

// Everything still to do across the story: unresolved selection markers
// plus TODO: lines found in the prose, in scene order. Postgres decides
// which bodies are worth sending: only scenes whose text contains "TODO:"
// or that hold an unresolved marker with no note (its snippet is sliced
// from the body here, since anchors are UTF-16 offsets and Postgres counts
// code points). Every other scene comes back without its body. The
// subquery names its columns by hand: Drizzle leaves columns in a select
// field unqualified, so the correlation would bind to scene_markers.id.
export async function listStoryTodos(db: Database, storyId: string): Promise<StoryTodo[]> {
	const sceneRows = await db
		.select({
			id: scenes.id,
			title: scenes.title,
			bodyMd: sql<string | null>`case
				when strpos(${scenes.bodyMd}, 'TODO:') > 0
					or exists (
						select 1 from scene_markers m
						where m.scene_id = "scenes"."id"
							and m.resolved_at is null
							and coalesce(m.body_md, '') = ''
					)
				then ${scenes.bodyMd}
			end`
		})
		.from(scenes)
		.where(and(eq(scenes.storyId, storyId), isNull(scenes.deletedAt)))
		.orderBy(asc(scenes.globalPosition));
	const markerRows = await db
		.select({
			id: sceneMarkers.id,
			sceneId: sceneMarkers.sceneId,
			anchorStart: sceneMarkers.anchorStart,
			anchorEnd: sceneMarkers.anchorEnd,
			bodyMd: sceneMarkers.bodyMd
		})
		.from(sceneMarkers)
		.innerJoin(scenes, eq(sceneMarkers.sceneId, scenes.id))
		.where(and(eq(scenes.storyId, storyId), isNull(sceneMarkers.resolvedAt)))
		.orderBy(asc(sceneMarkers.anchorStart));
	const markersByScene = new Map<string, typeof markerRows>();
	for (const row of markerRows) {
		const list = markersByScene.get(row.sceneId);
		if (list) list.push(row);
		else markersByScene.set(row.sceneId, [row]);
	}

	const todos: StoryTodo[] = [];
	for (const scene of sceneRows) {
		// Anchors count \r\n as one character, as the editor does.
		const body = toLf(scene.bodyMd ?? '');
		for (const marker of markersByScene.get(scene.id) ?? []) {
			const snippet =
				marker.anchorStart !== null && marker.anchorEnd !== null
					? body.slice(marker.anchorStart, marker.anchorEnd)
					: '';
			todos.push({
				sceneId: scene.id,
				sceneTitle: scene.title,
				markerId: marker.id,
				text: marker.bodyMd || snippet.slice(0, 120)
			});
		}
		for (const line of findTodoLines(body)) {
			todos.push({
				sceneId: scene.id,
				sceneTitle: scene.title,
				markerId: null,
				text: line.text || 'TODO'
			});
		}
	}
	return todos;
}
