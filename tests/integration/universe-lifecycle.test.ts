import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	assets,
	characters,
	entityCategories,
	entityRelationships,
	exportArtifacts,
	notifications,
	pendingObjectDeletions,
	places,
	reviewComments,
	publicationAssets,
	publications,
	relationTypes,
	revisions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	destroyUniverse,
	listTrashedUniverses,
	listUniversesDueForPurge,
	purgeUniverse,
	restoreUniverse,
	trashUniverse,
	universeEditionFileKeys
} from '../../src/lib/server/universe-lifecycle';
import { ownedStory } from '../../src/lib/server/story-access';
import { ownedUniverse } from '../../src/lib/server/universe-access';
import { searchAll } from '../../src/lib/server/search';
import { recordRevision } from '../../src/lib/server/revisions';
import { ownedScene } from '../../src/lib/server/scene-access';
import { ownedEntityBody } from '../../src/lib/server/revisions';
import { getEntityCard } from '../../src/lib/server/plan-data';
import { setEntityBadgeColor } from '../../src/lib/server/entity-badge';
import { ownedStoryUniverse, ownsUniverse } from '../../src/lib/server/llm/tools/dispatch';
import { loadStoryScope, loadUniverseScope } from '../../src/lib/server/llm/context/sources';
import {
	createReviewInvitation,
	createSuggestion,
	createThread,
	decideSuggestion,
	deleteComment,
	deleteSuggestion,
	ensureReviewer,
	invitationByToken,
	reviewerAccess,
	setThreadResolved
} from '../../src/lib/server/review';
import { createMarker, deleteMarker, setMarkerResolved } from '../../src/lib/server/markers';
import { createAsset, type AssetObjectStore } from '../../src/lib/server/assets';
import {
	FREED_OBJECT_EXTRA_DAYS,
	sweepUnusedAssets,
	UNREFERENCED_DAYS
} from '../../src/lib/server/unused-assets';
import { createChapter, createScene, trashScene } from '../../src/lib/server/scene-lifecycle';
import { duplicateScene, mergeScenes } from '../../src/lib/server/scene-split-merge';
import { clearMentionPin, setMentionPin } from '../../src/lib/server/mention-pins';
import { declareMembership } from '../../src/lib/server/membership';
import { saveEntity } from '../../src/lib/server/entity-save';
import { createRelationship, deleteRelationship } from '../../src/lib/server/relationships';
import { createStoryNote, getNote, setNotePinned } from '../../src/lib/server/notes';
import { notifyReviewActivity } from '../../src/lib/server/notify';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let universeId: string;
let storyId: string;
let characterId: string;
let typeId: string;
let sceneId: string;
let placeId: string;
let secondSceneId: string;
let reviewToken: string;
let reviewerId: string;
let noteId: string;
let markerId: string;
let relationshipId: string;
let threadId: string;
let commentId: string;
let suggestionId: string;

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const assetConfig = {
	endpoint: undefined,
	region: 'auto',
	bucket: 'test',
	prefix: 'codex-assets',
	accessKeyId: 'id',
	secretAccessKey: 'secret'
};
const nullStore: AssetObjectStore = {
	async put() {},
	async upload() {},
	async get() {
		throw new Error('not stored');
	},
	async remove() {}
};

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');

	const [owner] = await db
		.insert(users)
		.values({ email: 'uni@example.com', displayName: 'U', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'uni2@example.com', displayName: 'U2', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;

	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Closing Time', slug: 'closing-time' })
		.returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'Last Orders', slug: 'last-orders' })
		.returning();
	storyId = story.id;
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, title: 'Bell', bodyMd: 'The bell rang.' })
		.returning();
	sceneId = scene.id;
	const [secondScene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 2, title: 'Last call', bodyMd: 'Time, please.' })
		.returning();
	secondSceneId = secondScene.id;
	const invitation = await createReviewInvitation(db, { storyId, createdBy: ownerId });
	reviewToken = invitation.token;
	const reviewer = await ensureReviewer(db, invitation.id, { displayName: 'Guest' });
	reviewerId = reviewer!.id;
	noteId = await createStoryNote(db, ownerId, universeId, storyId);
	const [category] = await db
		.insert(entityCategories)
		.values({ universeId, ownerId, name: 'Lore', sortOrder: 0 })
		.returning();
	const [character] = await db
		.insert(characters)
		.values({ universeId, ownerId, name: 'Mara', categoryId: category.id })
		.returning();
	characterId = character.id;
	const [place] = await db
		.insert(places)
		.values({ universeId, ownerId, name: 'The Anchor', categoryId: category.id })
		.returning();
	placeId = place.id;
	await recordRevision(db, 'character', characterId, 'A barkeep.');
	const [relType] = await db
		.insert(relationTypes)
		.values({
			universeId,
			key: 'patron-of',
			forwardLabel: 'patron of',
			fromType: 'character',
			toType: 'place'
		})
		.returning();
	typeId = relType.id;

	const marker = await createMarker(db, ownerId, sceneId, 0, 4);
	if (!marker.ok) throw new Error(marker.reason);
	markerId = marker.id;
	const relationship = await createRelationship(db, ownerId, {
		fromKind: 'character',
		fromId: characterId,
		relationTypeId: typeId,
		toId: placeId
	});
	if (!relationship.ok) throw new Error(relationship.reason);
	relationshipId = relationship.id;
	const thread = await createThread(db, {
		storyId,
		sceneId,
		anchor: { start: 0, end: 3 },
		author: { reviewerId },
		body: 'Lovely.'
	});
	if (!thread.ok) throw new Error(thread.reason);
	threadId = thread.threadId;
	const [comment] = await db
		.select({ id: reviewComments.id })
		.from(reviewComments)
		.where(eq(reviewComments.threadId, threadId));
	commentId = comment.id;
	const suggestion = await createSuggestion(db, {
		storyId,
		sceneId,
		author: { reviewerId },
		range: { start: 4, end: 8 },
		replacement: 'gong'
	});
	if (!suggestion.ok) throw new Error(suggestion.reason);
	suggestionId = suggestion.suggestionId;
});

afterAll(async () => {
	await pool.end();
});

describe('trash and restore', () => {
	it('a trashed universe leaves every resolver and search', async () => {
		expect(await trashUniverse(db, strangerId, universeId)).toBe(false);
		expect(await trashUniverse(db, ownerId, universeId)).toBe(true);

		await expect(ownedUniverse('closing-time', ownerId, db)).rejects.toMatchObject({
			status: 404
		});
		await expect(ownedStory('last-orders', ownerId, db)).rejects.toMatchObject({ status: 404 });
		expect(await searchAll(db, ownerId, 'Mara')).toEqual([]);
		expect(await searchAll(db, ownerId, 'bell')).toEqual([]);

		const trashed = await listTrashedUniverses(db, ownerId);
		expect(trashed.map((row) => row.id)).toEqual([universeId]);
		expect(trashed[0].daysLeft).toBe(30);
	});

	it('by-id lookups, Assistant scopes, and guest review stop resolving too', async () => {
		await trashUniverse(db, ownerId, universeId);
		expect(await ownedScene(db, ownerId, sceneId)).toBeNull();
		expect(await ownedEntityBody(db, ownerId, 'scene', sceneId)).toBeNull();
		expect(await ownedEntityBody(db, ownerId, 'character', characterId)).toBeNull();
		expect(await getEntityCard(db, ownerId, characterId)).toBeNull();
		expect((await setEntityBadgeColor(db, ownerId, characterId, null)).ok).toBe(false);
		expect(await ownsUniverse(db, ownerId, universeId)).toBe(false);
		expect(await ownedStoryUniverse(db, ownerId, storyId)).toBeNull();
		expect(await loadUniverseScope(db, ownerId, universeId)).toBeNull();
		expect(await loadStoryScope(db, ownerId, storyId)).toBeNull();
		expect((await invitationByToken(db, reviewToken)).status).toBe('unknown');
		expect(await reviewerAccess(db, reviewerId, storyId)).toBeNull();
	});

	it('refuses writes and reads by id inside the trashed universe', async () => {
		await trashUniverse(db, ownerId, universeId);
		const refusals: [string, () => Promise<unknown>][] = [
			['createChapter', () => createChapter(db, ownerId, storyId)],
			['createScene', () => createScene(db, ownerId, storyId)],
			['trashScene', () => trashScene(db, ownerId, sceneId)],
			['duplicateScene', () => duplicateScene(db, ownerId, sceneId)],
			['mergeScenes', () => mergeScenes(db, ownerId, storyId, [sceneId, secondSceneId])],
			[
				'setMentionPin',
				() => setMentionPin(db, ownerId, storyId, 'Mara', 'character', characterId)
			],
			['clearMentionPin', () => clearMentionPin(db, ownerId, storyId, 'Mara')],
			[
				'declareMembership',
				() => declareMembership(db, ownerId, 'character', characterId, storyId)
			],
			[
				'saveEntity',
				() =>
					saveEntity(db, 'character', characterId, ownerId, {
						name: 'Mara',
						tags: [],
						summaryMd: null,
						bodyMd: 'Rewritten.'
					})
			],
			[
				'createRelationship',
				() =>
					createRelationship(db, ownerId, {
						fromKind: 'character',
						fromId: characterId,
						relationTypeId: typeId,
						toId: placeId
					})
			],
			['getNote', () => getNote(db, noteId, ownerId)],
			['setNotePinned', () => setNotePinned(db, noteId, ownerId, true)],
			['ownedEntityBody note', () => ownedEntityBody(db, ownerId, 'note', noteId)],
			['setMarkerResolved', () => setMarkerResolved(db, ownerId, markerId, true)],
			['deleteMarker', () => deleteMarker(db, ownerId, markerId)],
			['deleteRelationship', () => deleteRelationship(db, relationshipId, ownerId)],
			['setThreadResolved', () => setThreadResolved(db, ownerId, storyId, threadId, true)],
			['decideSuggestion', () => decideSuggestion(db, ownerId, storyId, suggestionId, false)],
			['deleteComment', () => deleteComment(db, { reviewerId }, storyId, commentId)],
			['deleteSuggestion', () => deleteSuggestion(db, { reviewerId }, storyId, suggestionId)],
			[
				'createAsset',
				() =>
					createAsset(db, nullStore, assetConfig, ownerId, {
						universeId,
						kind: 'inline',
						filename: 'x.png',
						contentType: 'image/png',
						bytes: PNG
					})
			]
		];
		const allowed: string[] = [];
		for (const [name, call] of refusals) {
			const result = await call();
			const refused =
				result === null ||
				result === false ||
				(typeof result === 'object' && result !== null && 'ok' in result && !result.ok);
			if (!refused) allowed.push(name);
		}
		expect(allowed).toEqual([]);
		const [{ total: before }] = await db
			.select({ total: sql<number>`count(*)::int` })
			.from(notifications);
		await notifyReviewActivity(
			db,
			storyId,
			'Guest',
			'commented',
			{ threadId: randomUUID() },
			'Late note.'
		);
		const [{ total: after }] = await db
			.select({ total: sql<number>`count(*)::int` })
			.from(notifications);
		expect(after).toBe(before);
	});

	it('is not due for the purge until the window elapses', async () => {
		await trashUniverse(db, ownerId, universeId);
		expect(await listUniversesDueForPurge(db)).toEqual([]);
		await db
			.update(universes)
			.set({ deletedAt: sql`now() - interval '31 days'` })
			.where(eq(universes.id, universeId));
		expect(await listUniversesDueForPurge(db)).toEqual([universeId]);
	});

	it('restore brings everything back whole', async () => {
		await trashUniverse(db, ownerId, universeId);
		expect(await restoreUniverse(db, ownerId, universeId)).toBe(true);
		expect((await ownedUniverse('closing-time', ownerId, db)).id).toBe(universeId);
		expect((await ownedStory('last-orders', ownerId, db)).story.id).toBe(storyId);
		expect((await searchAll(db, ownerId, 'Mara')).length).toBeGreaterThan(0);
		expect((await ownedScene(db, ownerId, sceneId))?.id).toBe(sceneId);
		expect(await ownedEntityBody(db, ownerId, 'character', characterId)).not.toBeNull();
		expect(await getEntityCard(db, ownerId, characterId)).not.toBeNull();
		expect(await ownsUniverse(db, ownerId, universeId)).toBe(true);
		expect(await ownedStoryUniverse(db, ownerId, storyId)).toBe(universeId);
		expect((await invitationByToken(db, reviewToken)).status).toBe('ok');
		expect(await reviewerAccess(db, reviewerId, storyId)).not.toBeNull();
		expect((await getNote(db, noteId, ownerId))?.id).toBe(noteId);
		// Review actions are scoped to the story they are asked about.
		const otherStory = '00000000-0000-4000-8000-000000000000';
		expect(await setThreadResolved(db, ownerId, otherStory, threadId, true)).toBe(false);
		expect((await decideSuggestion(db, ownerId, otherStory, suggestionId, false)).ok).toBe(false);
		expect((await deleteComment(db, { reviewerId }, otherStory, commentId)).ok).toBe(false);
		expect((await deleteSuggestion(db, { reviewerId }, otherStory, suggestionId)).ok).toBe(false);
		expect(await restoreUniverse(db, ownerId, universeId)).toBe(false);
	});
});

describe('universeEditionFileKeys', () => {
	it('lists the editions stored export files, not the images', async () => {
		await db
			.insert(assets)
			.values({
				ownerId,
				universeId,
				kind: 'inline',
				filename: 'x.png',
				contentType: 'image/png',
				byteSize: 1,
				storageKey: 'img-key'
			})
			.returning();
		const [pub] = await db
			.insert(publications)
			.values({ storyId, ownerId, handle: 'h', title: 'Ed', content: {}, isCurrent: true })
			.returning();
		await db.insert(exportArtifacts).values({
			publicationId: pub.id,
			format: 'epub',
			storageKey: 'epub-key',
			filename: 'e.epub',
			contentType: 'application/epub+zip',
			byteSize: 20
		});

		expect(await universeEditionFileKeys(db, universeId)).toEqual(['epub-key']);
	});
});

describe('destroy', () => {
	it('refuses a live universe, then purges a trashed one completely', async () => {
		expect((await destroyUniverse(db, ownerId, universeId)).ok).toBe(false);
		await trashUniverse(db, ownerId, universeId);
		await db.insert(assets).values({
			ownerId,
			universeId,
			kind: 'inline',
			filename: 'gone.png',
			contentType: 'image/png',
			byteSize: 1,
			storageKey: 'destroyed-img-key',
			createdAt: new Date(Date.now() - 60 * 86_400_000)
		});
		expect((await destroyUniverse(db, strangerId, universeId)).ok).toBe(false);
		expect((await destroyUniverse(db, ownerId, universeId)).ok).toBe(true);
		// The image is left, marked, for the unused image sweep.
		const [image] = await db
			.select()
			.from(assets)
			.where(eq(assets.storageKey, 'destroyed-img-key'));
		expect(image).toMatchObject({ universeId: null });
		expect(image.unreferencedSince).not.toBeNull();

		expect(await db.select().from(universes).where(eq(universes.id, universeId))).toHaveLength(0);
		expect(await db.select().from(stories).where(eq(stories.id, storyId))).toHaveLength(0);
		expect(await db.select().from(characters).where(eq(characters.id, characterId))).toHaveLength(
			0
		);
		// The pieces the old account purge leaked: custom relation types and
		// entity history.
		expect(await db.select().from(relationTypes).where(eq(relationTypes.id, typeId))).toHaveLength(
			0
		);
		expect(
			await db.select().from(revisions).where(eq(revisions.entityId, characterId))
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(entityRelationships)
				.where(eq(entityRelationships.universeId, universeId))
		).toHaveLength(0);
	});
});

describe('purging a universe', () => {
	// An image uploaded in this universe, 5 bytes, counted against its owner,
	// old enough by default to be past the unused image grace period.
	async function imageHere(storageKey = 'shared-key', daysOld = 60) {
		const [image] = await db
			.insert(assets)
			.values({
				ownerId,
				universeId,
				kind: 'inline',
				filename: 'map.png',
				contentType: 'image/png',
				byteSize: 5,
				storageKey,
				createdAt: new Date(Date.now() - daysOld * 86_400_000)
			})
			.returning();
		await db.update(users).set({ storageUsedBytes: 5 }).where(eq(users.id, ownerId));
		return image;
	}

	// A second universe of the same owner, with a story and one scene.
	async function otherUniverse(bodyMd: string) {
		const [other] = await db
			.insert(universes)
			.values({ ownerId, name: 'Open Late', slug: 'open-late' })
			.returning();
		const [story] = await db
			.insert(stories)
			.values({ universeId: other.id, ownerId, title: 'Doors', slug: 'doors' })
			.returning();
		await db.insert(scenes).values({ storyId: story.id, globalPosition: 1, bodyMd });
		return story;
	}

	const storageUsed = async () =>
		(await db.select().from(users).where(eq(users.id, ownerId)))[0].storageUsedBytes;
	const queued = async (key: string) =>
		(
			await db
				.select()
				.from(pendingObjectDeletions)
				.where(eq(pendingObjectDeletions.storageKey, key))
		).length > 0;

	const imageRow = async (id: string) =>
		(await db.select().from(assets).where(eq(assets.id, id)))[0];
	// Moves an image's unused mark back far enough for the sweep to free it.
	const markLongAgo = (id: string) =>
		db
			.update(assets)
			.set({ unreferencedSince: new Date(Date.now() - (UNREFERENCED_DAYS + 1) * 86_400_000) })
			.where(eq(assets.id, id));

	it('keeps its images, marked, for the sweep to free once they are due', async () => {
		await pool.query('truncate table pending_object_deletions');
		const image = await imageHere();
		await trashUniverse(db, ownerId, universeId);
		expect(await purgeUniverse(db, universeId)).toBe(true);
		const kept = await imageRow(image.id);
		expect(kept).toMatchObject({ universeId: null });
		expect(kept.unreferencedSince).not.toBeNull();
		expect(await storageUsed()).toBe(5);
		expect(await queued('shared-key')).toBe(false);

		// Not due yet: unused for less than the waiting period.
		expect(await sweepUnusedAssets(db)).toEqual({ count: 0, bytes: 0 });
		expect(await imageRow(image.id)).toBeDefined();

		await markLongAgo(image.id);
		expect(await sweepUnusedAssets(db)).toEqual({ count: 1, bytes: 5 });
		expect(await imageRow(image.id)).toBeUndefined();
		expect(await storageUsed()).toBe(0);
		// Kept as long as a file the unused image sweep frees.
		const [row] = await db
			.select()
			.from(pendingObjectDeletions)
			.where(eq(pendingObjectDeletions.storageKey, 'shared-key'));
		const ahead = (row.deletedAt.getTime() - Date.now()) / 86_400_000;
		expect(ahead).toBeGreaterThan(FREED_OBJECT_EXTRA_DAYS - 1);
	});

	it('starts the 30 days afresh over an earlier unused mark', async () => {
		const image = await imageHere();
		// A stale mark, old enough that keeping it would let the image go at once.
		await markLongAgo(image.id);
		await trashUniverse(db, ownerId, universeId);
		expect(await purgeUniverse(db, universeId)).toBe(true);
		const since = (await imageRow(image.id)).unreferencedSince!;
		expect(Date.now() - since.getTime()).toBeLessThan(60_000);
		expect(await sweepUnusedAssets(db)).toEqual({ count: 0, bytes: 0 });
	});

	it('does not free an image newer than the grace period', async () => {
		const image = await imageHere('new-key', 1);
		await trashUniverse(db, ownerId, universeId);
		expect(await purgeUniverse(db, universeId)).toBe(true);
		await markLongAgo(image.id);
		expect(await sweepUnusedAssets(db)).toEqual({ count: 0, bytes: 0 });
		expect(await imageRow(image.id)).toMatchObject({ universeId: null });
		expect(await storageUsed()).toBe(5);
	});

	it('keeps an image a scene in another universe shows', async () => {
		await pool.query('truncate table pending_object_deletions');
		const image = await imageHere();
		await otherUniverse(`A map: ![map](/assets/${image.id})`);
		await trashUniverse(db, ownerId, universeId);
		expect(await purgeUniverse(db, universeId)).toBe(true);
		await markLongAgo(image.id);
		expect(await sweepUnusedAssets(db)).toEqual({ count: 0, bytes: 0 });
		const kept = await imageRow(image.id);
		expect(kept).toMatchObject({ universeId: null, storageKey: 'shared-key' });
		// The sweep saw it in use and cleared the mark.
		expect(kept.unreferencedSince).toBeNull();
		expect(await storageUsed()).toBe(5);
		expect(await queued('shared-key')).toBe(false);
	});

	it('does not hold the account while it reads every column', async () => {
		await imageHere();
		await trashUniverse(db, ownerId, universeId);
		const holder = await pool.connect();
		try {
			// A table the purge has no business with but a read of every column
			// would wait for: while the purge runs, the account row must stay
			// free to lock.
			await holder.query('begin');
			await holder.query('lock table app_settings in access exclusive mode');
			const running = purgeUniverse(db, universeId);
			await new Promise((resolve) => setTimeout(resolve, 200));
			const probe = await pool.connect();
			try {
				await probe.query('begin');
				await probe.query('set local lock_timeout = 1000');
				await probe.query('select id from users where id = $1 for no key update', [ownerId]);
				await probe.query('rollback');
			} finally {
				probe.release();
			}
			await holder.query('commit');
			expect(await running).toBe(true);
		} finally {
			holder.release();
		}
	});

	it('goes through when an edition in another universe holds one of its images', async () => {
		const image = await imageHere();
		const story = await otherUniverse('No images in the draft any more.');
		const [edition] = await db
			.insert(publications)
			.values({ storyId: story.id, ownerId, handle: 'h', title: 'Doors', content: {} })
			.returning();
		await db.insert(publicationAssets).values({ publicationId: edition.id, assetId: image.id });
		await trashUniverse(db, ownerId, universeId);
		expect(await purgeUniverse(db, universeId)).toBe(true);
		expect(await db.select().from(universes).where(eq(universes.id, universeId))).toEqual([]);
		expect(await db.select().from(assets).where(eq(assets.id, image.id))).toHaveLength(1);
	});

	it('leaves a universe restored before the purge got to it', async () => {
		await trashUniverse(db, ownerId, universeId);
		expect(await restoreUniverse(db, ownerId, universeId)).toBe(true);
		expect(await purgeUniverse(db, universeId)).toBe(false);
		expect((await destroyUniverse(db, ownerId, universeId)).ok).toBe(false);
		expect(await db.select().from(universes).where(eq(universes.id, universeId))).toHaveLength(1);
		expect(await db.select().from(stories).where(eq(stories.id, storyId))).toHaveLength(1);
	});

	it('on schedule, waits until the universe has been in the trash long enough', async () => {
		await trashUniverse(db, ownerId, universeId);
		expect(await purgeUniverse(db, universeId, { dueAfterDays: 30 })).toBe(false);
		expect(await db.select().from(universes).where(eq(universes.id, universeId))).toHaveLength(1);
		await db
			.update(universes)
			.set({ deletedAt: sql`now() - interval '31 days'` })
			.where(eq(universes.id, universeId));
		expect(await purgeUniverse(db, universeId, { dueAfterDays: 30 })).toBe(true);
		expect(await db.select().from(universes).where(eq(universes.id, universeId))).toEqual([]);
	});
});
