import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	assets,
	chapters,
	exportArtifacts,
	publicationAssets,
	publications,
	scenes,
	slugHistory,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { artifactForDownload } from '../../src/lib/server/export-artifacts';
import { removeFromBrowse } from '../../src/lib/server/browse';
import { instanceStats } from '../../src/lib/server/admin';
import {
	isPublicAsset,
	isPublicAvatar,
	listBrowseBlocked,
	listLiveEditions,
	LIVE_EDITIONS_PAGE_SIZE,
	publicAuthorIdentity,
	publicEdition,
	publicProfile,
	publicShelf,
	publicStoryRedirect,
	publicUniverse,
	publicUniverseLink,
	publicUniverseRedirect,
	publishStory,
	readingPageRef,
	takedownPublication,
	restorePublication,
	type EditionContent
} from '../../src/lib/server/publish';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let authorId: string;
let universeId: string;
let storyId: string;
let sceneId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table publication_assets, publications, assets, scenes, chapters, stories, universes, users cascade'
	);

	const [author] = await db
		.insert(users)
		.values({
			email: 'pub@example.com',
			displayName: 'Pub',
			passwordHash: 'x',
			role: 'user',
			handle: 'inkwright',
			publicArchiveEnabled: true
		})
		.returning();
	authorId = author.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: authorId, name: 'U' })
		.returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({
			universeId: universe.id,
			ownerId: authorId,
			title: 'Book of Ash',
			author: 'A. Vane',
			visibility: 'public'
		})
		.returning();
	storyId = story.id;
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId, title: 'The Caravan', position: 1 })
		.returning();
	const [scene] = await db
		.insert(scenes)
		.values({
			storyId,
			chapterId: chapter.id,
			globalPosition: 1,
			title: 'Departure',
			bodyMd: 'The gate opened.'
		})
		.returning();
	sceneId = scene.id;
});

afterAll(async () => {
	await pool.end();
});

// Every edition on the instance, superseded and taken down included.
async function allEditions() {
	return await db
		.select({
			id: publications.id,
			title: publications.title,
			isCurrent: publications.isCurrent
		})
		.from(publications);
}

describe('publishStory', () => {
	it('is gated on the admin-granted archive and a handle', async () => {
		await db.update(users).set({ publicArchiveEnabled: false }).where(eq(users.id, authorId));
		expect(await publishStory(db, authorId, storyId)).toMatchObject({
			ok: false,
			reason: 'The site admin has not turned on your public archive yet.'
		});
	});

	it('freezes the prose into an edition', async () => {
		const result = await publishStory(db, authorId, storyId, 'First edition');
		expect(result).toMatchObject({ ok: true });

		const edition = await publicEdition(db, 'inkwright', storyId);
		expect(edition).toMatchObject({ title: 'Book of Ash', versionLabel: 'First edition' });
		const content = edition!.content as EditionContent;
		expect(content.chapters[0].title).toBe('The Caravan');
		expect(content.chapters[0].scenes[0].bodyMd).toBe('The gate opened.');
	});

	it('keeps the edition frozen while the draft moves on, until republish', async () => {
		await publishStory(db, authorId, storyId);
		await db.update(scenes).set({ bodyMd: 'The gate stayed shut.' }).where(eq(scenes.id, sceneId));
		let edition = await publicEdition(db, 'inkwright', storyId);
		expect((edition!.content as EditionContent).chapters[0].scenes[0].bodyMd).toBe(
			'The gate opened.'
		);

		const again = await publishStory(db, authorId, storyId);
		expect(again).toMatchObject({ ok: true });
		edition = await publicEdition(db, 'inkwright', storyId);
		expect((edition!.content as EditionContent).chapters[0].scenes[0].bodyMd).toBe(
			'The gate stayed shut.'
		);
		// Exactly one current edition.
		const all = await allEditions();
		expect(all.filter((row) => row.isCurrent)).toHaveLength(1);
		expect(all).toHaveLength(2);
	});
});

describe('shelf and visibility', () => {
	it('lists public stories on the shelf; unlisted stays direct-link only', async () => {
		await publishStory(db, authorId, storyId);
		expect(await publicShelf(db, 'inkwright')).toHaveLength(1);

		await db.update(stories).set({ visibility: 'unlisted' }).where(eq(stories.id, storyId));
		expect(await publicShelf(db, 'inkwright')).toHaveLength(0);
		expect(await publicEdition(db, 'inkwright', storyId)).not.toBeNull();

		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect(await publicEdition(db, 'inkwright', storyId)).toBeNull();
	});
});

describe('takedown and covers', () => {
	it('an admin takedown hides the edition without touching the source', async () => {
		await publishStory(db, authorId, storyId);
		const [current] = (await allEditions()).filter((row) => row.isCurrent);
		expect(await takedownPublication(db, current.id, null, 'other')).toBe(true);
		expect(await takedownPublication(db, current.id, null, 'other')).toBe(false);
		expect(await publicEdition(db, 'inkwright', storyId)).toBeNull();
		expect(await publicShelf(db, 'inkwright')).toHaveLength(0);
		const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId));
		expect(scene.bodyMd).toBe('The gate opened.');
	});

	it('treats a cover as public only while an edition is readable', async () => {
		const coverId = crypto.randomUUID();
		await db.update(stories).set({ coverAssetId: coverId }).where(eq(stories.id, storyId));
		const first = await publishStory(db, authorId, storyId);
		if (!first.ok) throw new Error(first.reason);
		await takedownPublication(db, first.publicationId, null, 'other');
		// The only current edition is taken down.
		expect(await isPublicAsset(db, coverId)).toBe(false);
		await restorePublication(db, first.publicationId);
		expect(await isPublicAsset(db, coverId)).toBe(true);

		// Making the story private must stop the cover serving, matching
		// publicEdition; unlisted stays reachable by direct link.
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect(await isPublicAsset(db, coverId)).toBe(false);
		await db.update(stories).set({ visibility: 'unlisted' }).where(eq(stories.id, storyId));
		expect(await isPublicAsset(db, coverId)).toBe(true);
	});

	it('serves inline images of a readable edition, and stops on takedown', async () => {
		const [asset] = await db
			.insert(assets)
			.values({
				ownerId: authorId,
				universeId,
				kind: 'inline',
				filename: 'sketch.png',
				contentType: 'image/png',
				byteSize: 8,
				storageKey: 'codex-assets/sketch'
			})
			.returning();
		const [inlineStory] = await db
			.insert(stories)
			.values({ universeId, ownerId: authorId, title: 'Illustrated', visibility: 'public' })
			.returning();
		await db.insert(scenes).values({
			storyId: inlineStory.id,
			globalPosition: 1,
			bodyMd: `A picture: ![sketch](/assets/${asset.id})`
		});

		// Unreferenced until published.
		expect(await isPublicAsset(db, asset.id)).toBe(false);
		expect(await publishStory(db, authorId, inlineStory.id)).toMatchObject({ ok: true });
		expect(await isPublicAsset(db, asset.id)).toBe(true);

		const [current] = (await allEditions()).filter(
			(row) => row.title === 'Illustrated' && row.isCurrent
		);
		await takedownPublication(db, current.id, null, 'other');
		expect(await isPublicAsset(db, asset.id)).toBe(false);
	});
});

describe('moderation lists', () => {
	// n stories with one current edition each, all newer than anything
	// published through publishStory in the test.
	async function publishMany(n: number) {
		const later = Date.now() + 60_000;
		const ids: string[] = [];
		for (let i = 0; i < n; i++) {
			const [story] = await db
				.insert(stories)
				.values({ universeId, ownerId: authorId, title: `Story ${i}`, visibility: 'public' })
				.returning();
			const [edition] = await db
				.insert(publications)
				.values({
					storyId: story.id,
					ownerId: authorId,
					handle: 'inkwright',
					title: `Story ${i}`,
					content: { chapters: [] },
					publishedAt: new Date(later + i * 1000)
				})
				.returning();
			ids.push(edition.id);
		}
		return ids;
	}

	it('lists only current editions that are up, however many newer ones are removed', async () => {
		const first = await publishStory(db, authorId, storyId);
		if (!first.ok) throw new Error(first.reason);
		const second = await publishStory(db, authorId, storyId);
		if (!second.ok) throw new Error(second.reason);
		const newer = await publishMany(LIVE_EDITIONS_PAGE_SIZE + 1);
		for (const id of newer) await takedownPublication(db, id, null, 'spam');

		const live = await listLiveEditions(db);
		expect(live.editions.map((row) => row.id)).toEqual([second.publicationId]);
		expect(live).toMatchObject({ total: 1, page: 0, hasMore: false });
		expect((await instanceStats(db)).publishedEditions).toBe(1);
	});

	it('pages through live editions and searches by handle or title', async () => {
		await publishMany(LIVE_EDITIONS_PAGE_SIZE + 2);
		const first = await listLiveEditions(db);
		expect(first.editions).toHaveLength(LIVE_EDITIONS_PAGE_SIZE);
		expect(first).toMatchObject({ total: LIVE_EDITIONS_PAGE_SIZE + 2, hasMore: true });
		const second = await listLiveEditions(db, { page: 1 });
		expect(second.editions).toHaveLength(2);
		expect(second.hasMore).toBe(false);
		const seen = new Set([...first.editions, ...second.editions].map((row) => row.id));
		expect(seen.size).toBe(LIVE_EDITIONS_PAGE_SIZE + 2);

		const found = await listLiveEditions(db, { query: 'story 7' });
		expect(found.editions.map((row) => row.title)).toEqual(['Story 7']);
		expect((await listLiveEditions(db, { query: 'INKWRIGHT' })).total).toBe(
			LIVE_EDITIONS_PAGE_SIZE + 2
		);
		// LIKE wildcards in the search are taken literally.
		expect((await listLiveEditions(db, { query: '%' })).total).toBe(0);
	});

	it('lists a story removed from Browse on its own until it is allowed again', async () => {
		await publishStory(db, authorId, storyId);
		await publishMany(LIVE_EDITIONS_PAGE_SIZE + 1);
		expect(await removeFromBrowse(db, storyId, authorId, 'spam')).toBe(true);
		const live = await listLiveEditions(db);
		expect(live.editions.some((row) => row.storyId === storyId)).toBe(false);
		expect(await listBrowseBlocked(db)).toMatchObject([
			{ storyId, title: 'Book of Ash', handle: 'inkwright', browseBlockedReason: 'spam' }
		]);
	});
});

describe('inline images owned by someone else', () => {
	it("never makes another user's image public, and ignores ids that do not exist", async () => {
		const [stranger] = await db
			.insert(users)
			.values({ email: 'victim@example.com', displayName: 'V', passwordHash: 'x', role: 'user' })
			.returning();
		const [strangerUniverse] = await db
			.insert(universes)
			.values({ ownerId: stranger.id, name: 'Private' })
			.returning();
		const [foreign] = await db
			.insert(assets)
			.values({
				ownerId: stranger.id,
				universeId: strangerUniverse.id,
				kind: 'inline',
				filename: 'secret.png',
				contentType: 'image/png',
				byteSize: 8,
				storageKey: 'codex-assets/secret'
			})
			.returning();
		const missing = '00000000-0000-4000-8000-000000000000';
		const [borrowing] = await db
			.insert(stories)
			.values({ universeId, ownerId: authorId, title: 'Borrowed', visibility: 'unlisted' })
			.returning();
		await db.insert(scenes).values({
			storyId: borrowing.id,
			globalPosition: 1,
			bodyMd: `![a](/assets/${foreign.id}) and ![b](/assets/${missing})`
		});

		expect(await publishStory(db, authorId, borrowing.id)).toMatchObject({ ok: true });
		expect(await isPublicAsset(db, foreign.id)).toBe(false);
	});

	it('does not serve a foreign image already linked to an edition', async () => {
		const [stranger] = await db
			.insert(users)
			.values({ email: 'victim2@example.com', displayName: 'V2', passwordHash: 'x', role: 'user' })
			.returning();
		const [strangerUniverse] = await db
			.insert(universes)
			.values({ ownerId: stranger.id, name: 'Private 2' })
			.returning();
		const [foreign] = await db
			.insert(assets)
			.values({
				ownerId: stranger.id,
				universeId: strangerUniverse.id,
				kind: 'inline',
				filename: 'old.png',
				contentType: 'image/png',
				byteSize: 8,
				storageKey: 'codex-assets/old'
			})
			.returning();
		const [oldStory] = await db
			.insert(stories)
			.values({ universeId, ownerId: authorId, title: 'Old edition', visibility: 'public' })
			.returning();
		await db.insert(scenes).values({ storyId: oldStory.id, globalPosition: 1, bodyMd: 'Text.' });
		const published = await publishStory(db, authorId, oldStory.id);
		if (!published.ok) throw new Error(published.reason);
		// As an edition published before links were owner-checked would have it.
		await db
			.insert(publicationAssets)
			.values({ publicationId: published.publicationId, assetId: foreign.id });
		expect(await isPublicAsset(db, foreign.id)).toBe(false);
	});
});

describe('public profile and avatar', () => {
	it('exposes the profile only while it is listed publicly', async () => {
		await db
			.update(users)
			.set({
				bioMd: 'Writes about salt and sea.',
				penName: 'A. Vane',
				links: [{ label: 'Site', url: 'https://vane.test' }],
				commissionsOpen: true,
				commissionsMd: 'Short fiction.',
				profilePublic: false
			})
			.where(eq(users.id, authorId));
		expect(await publicProfile(db, 'inkwright')).toBeNull();

		await db.update(users).set({ profilePublic: true }).where(eq(users.id, authorId));
		const profile = await publicProfile(db, 'inkwright');
		expect(profile).toMatchObject({
			penName: 'A. Vane',
			bioMd: 'Writes about salt and sea.',
			commissionsOpen: true,
			commissionsMd: 'Short fiction.'
		});
		expect(profile!.links).toEqual([{ label: 'Site', url: 'https://vane.test' }]);
	});

	it('serves the current avatar only while the profile is public', async () => {
		const [avatar] = await db
			.insert(assets)
			.values({
				ownerId: authorId,
				kind: 'avatar',
				filename: 'me.png',
				contentType: 'image/png',
				byteSize: 8,
				storageKey: 'codex-assets/me'
			})
			.returning();
		await db
			.update(users)
			.set({ avatarAssetId: avatar.id, profilePublic: true })
			.where(eq(users.id, authorId));

		expect(await isPublicAvatar(db, avatar.id)).toBe(true);
		await db.update(users).set({ profilePublic: false }).where(eq(users.id, authorId));
		expect(await isPublicAvatar(db, avatar.id)).toBe(false);
		// A stale id (no longer the current avatar) never serves.
		await db
			.update(users)
			.set({ profilePublic: true, avatarAssetId: null })
			.where(eq(users.id, authorId));
		expect(await isPublicAvatar(db, avatar.id)).toBe(false);
	});
});

describe('concurrent publish', () => {
	it('the partial index forbids two current editions of one story', async () => {
		const [story] = await db
			.insert(stories)
			.values({ universeId, ownerId: authorId, title: 'Solo', visibility: 'public' })
			.returning();
		const row = {
			storyId: story.id,
			ownerId: authorId,
			handle: 'inkwright',
			title: 'Solo',
			content: { chapters: [], unfiled: [] },
			isCurrent: true
		};
		await db.insert(publications).values(row);
		// A second current row for the same story is the race the partial
		// unique index exists to stop.
		await expect(db.insert(publications).values(row)).rejects.toMatchObject({
			cause: { code: '23505' }
		});
	});
});

// The unused-image sweep deleting an image the moment a publish links it.
// The trigger stands in for that delete landing between the publish's read
// of the image and its link row.
describe('an image deleted while the story publishes', () => {
	afterEach(async () => {
		await pool.query('drop trigger if exists test_delete_asset on publication_assets');
		await pool.query('drop function if exists test_delete_asset()');
	});

	it('refuses the publish with a plain message', async () => {
		const [asset] = await db
			.insert(assets)
			.values({
				ownerId: authorId,
				universeId,
				kind: 'inline',
				filename: 'gone.png',
				contentType: 'image/png',
				byteSize: 8,
				storageKey: 'codex-assets/gone'
			})
			.returning();
		await db
			.update(scenes)
			.set({ bodyMd: `![gone](/assets/${asset.id})` })
			.where(eq(scenes.id, sceneId));
		await pool.query(`
			create function test_delete_asset() returns trigger language plpgsql as $$
			begin
				delete from assets where id = new.asset_id;
				return new;
			end $$`);
		await pool.query(`create trigger test_delete_asset before insert on publication_assets
			for each row execute function test_delete_asset()`);
		expect(await publishStory(db, authorId, storyId)).toEqual({
			ok: false,
			reason: 'One of the images in this story was just deleted. Check the story and publish again.'
		});
		expect(await db.select().from(publications)).toEqual([]);
	});
});

// A second author, handle 'rival', with a universe under the same slug as the
// main author's and, optionally, a published public story under 'book-of-ash'.
async function addRival(options: { withStory: boolean }) {
	const [rival] = await db
		.insert(users)
		.values({
			email: 'rival@example.com',
			displayName: 'Rival',
			passwordHash: 'x',
			role: 'user',
			handle: 'rival',
			publicArchiveEnabled: true
		})
		.returning();
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: rival.id, name: 'Elsewhere', slug: 'ember-reach' })
		.returning();
	let rivalStoryId: string | null = null;
	if (options.withStory) {
		const [story] = await db
			.insert(stories)
			.values({
				universeId: universe.id,
				ownerId: rival.id,
				title: 'Their Ash',
				slug: 'book-of-ash',
				visibility: 'public'
			})
			.returning();
		await db.insert(scenes).values({ storyId: story.id, globalPosition: 1, bodyMd: 'Theirs.' });
		const published = await publishStory(db, rival.id, story.id);
		if (!published.ok) throw new Error(published.reason);
		rivalStoryId = story.id;
	}
	return { rivalUniverseId: universe.id, rivalStoryId };
}

describe('slug addresses', () => {
	beforeEach(async () => {
		await db.update(stories).set({ slug: 'book-of-ash' }).where(eq(stories.id, storyId));
		await db
			.update(universes)
			.set({ name: 'The Ember Reach', slug: 'ember-reach' })
			.where(eq(universes.id, universeId));
	});

	it('resolves a story by its slug, and by its id as before', async () => {
		await publishStory(db, authorId, storyId);
		const bySlug = await publicEdition(db, 'inkwright', 'book-of-ash');
		const byId = await publicEdition(db, 'inkwright', storyId);
		expect(bySlug).toMatchObject({ storyId, slug: 'book-of-ash', title: 'Book of Ash' });
		expect(byId?.id).toBe(bySlug?.id);
		expect(await publicEdition(db, 'inkwright', 'no-such-story')).toBeNull();
		// The shelf hands out the slug, and so does the owner's menu link.
		expect((await publicShelf(db, 'inkwright')).map((book) => book.slug)).toEqual(['book-of-ash']);
		expect(await readingPageRef(db, storyId)).toEqual({
			handle: 'inkwright',
			story: 'book-of-ash'
		});
		expect(bySlug?.address).toBe('book-of-ash');
	});

	it("never serves one author's story under another handle", async () => {
		await publishStory(db, authorId, storyId);
		const { rivalStoryId } = await addRival({ withStory: true });
		expect((await publicEdition(db, 'inkwright', 'book-of-ash'))?.storyId).toBe(storyId);
		expect((await publicEdition(db, 'rival', 'book-of-ash'))?.storyId).toBe(rivalStoryId);
		// An id from one author under the other's handle resolves to nothing.
		expect(await publicEdition(db, 'rival', storyId)).toBeNull();
		expect(await publicEdition(db, 'inkwright', rivalStoryId!)).toBeNull();
	});

	it('keeps an unlisted story at its id only; private and unpublished never', async () => {
		await db.update(stories).set({ visibility: 'unlisted' }).where(eq(stories.id, storyId));
		// Not yet published: a live story with that slug is not a page.
		expect(await publicEdition(db, 'inkwright', storyId)).toBeNull();
		await publishStory(db, authorId, storyId);
		// The title-derived slug is guessable, so an unlisted story answers
		// only at its id, and its links use the id.
		expect(await publicEdition(db, 'inkwright', 'book-of-ash')).toBeNull();
		expect((await publicEdition(db, 'inkwright', storyId))?.address).toBe(storyId);
		expect(await readingPageRef(db, storyId)).toEqual({ handle: 'inkwright', story: storyId });

		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect(await publicEdition(db, 'inkwright', storyId)).toBeNull();
		// The story menu offers no reading page that would 404.
		expect(await readingPageRef(db, storyId)).toBeNull();
	});

	it('serves the frozen edition, never the live draft, by slug too', async () => {
		await publishStory(db, authorId, storyId);
		await db.update(scenes).set({ bodyMd: 'Live words.' }).where(eq(scenes.id, sceneId));
		await db.update(stories).set({ title: 'Renamed live' }).where(eq(stories.id, storyId));
		const edition = await publicEdition(db, 'inkwright', 'book-of-ash');
		expect(edition?.title).toBe('Book of Ash');
		expect((edition!.content as EditionContent).chapters[0].scenes[0].bodyMd).toBe(
			'The gate opened.'
		);
	});

	it('serves nothing at a slug a trashed story freed for an unpublished one', async () => {
		await publishStory(db, authorId, storyId);
		await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, storyId));
		expect(await publicEdition(db, 'inkwright', 'book-of-ash')).toBeNull();
		expect(await publicEdition(db, 'inkwright', storyId)).toBeNull();
		await db.insert(stories).values({
			universeId,
			ownerId: authorId,
			title: 'Book of Ash',
			slug: 'book-of-ash',
			visibility: 'public'
		});
		expect(await publicEdition(db, 'inkwright', 'book-of-ash')).toBeNull();
	});

	it('hides everything in a trashed universe: edition, shelf, page, and cover', async () => {
		const coverId = crypto.randomUUID();
		await db.update(stories).set({ coverAssetId: coverId }).where(eq(stories.id, storyId));
		await publishStory(db, authorId, storyId);
		expect(await isPublicAsset(db, coverId)).toBe(true);
		expect(await publicUniverse(db, 'inkwright', 'ember-reach')).not.toBeNull();

		await db.update(universes).set({ deletedAt: new Date() }).where(eq(universes.id, universeId));
		expect(await publicEdition(db, 'inkwright', 'book-of-ash')).toBeNull();
		expect(await publicEdition(db, 'inkwright', storyId)).toBeNull();
		expect(await publicShelf(db, 'inkwright')).toEqual([]);
		expect(await publicUniverse(db, 'inkwright', 'ember-reach')).toBeNull();
		expect(await isPublicAsset(db, coverId)).toBe(false);
	});
});

describe('public universe page', () => {
	beforeEach(async () => {
		await db.update(stories).set({ slug: 'book-of-ash' }).where(eq(stories.id, storyId));
		await db
			.update(universes)
			.set({ name: 'The Ember Reach', slug: 'ember-reach' })
			.where(eq(universes.id, universeId));
	});

	async function addPublishedStory(
		inUniverse: string,
		title: string,
		slug: string,
		visibility: 'public' | 'unlisted'
	) {
		const [story] = await db
			.insert(stories)
			.values({ universeId: inUniverse, ownerId: authorId, title, slug, visibility })
			.returning();
		await db.insert(scenes).values({ storyId: story.id, globalPosition: 1, bodyMd: 'Words.' });
		const published = await publishStory(db, authorId, story.id);
		if (!published.ok) throw new Error(published.reason);
		return story.id;
	}

	it('shows the name and the listed stories only, by slug or id', async () => {
		await publishStory(db, authorId, storyId);
		await addPublishedStory(universeId, 'Hidden Path', 'hidden-path', 'unlisted');
		// A story that was never published stays off the page.
		await db
			.insert(stories)
			.values({ universeId, ownerId: authorId, title: 'Draft', visibility: 'public' });

		const page = await publicUniverse(db, 'inkwright', 'ember-reach');
		expect(page).toMatchObject({ id: universeId, name: 'The Ember Reach', slug: 'ember-reach' });
		expect(page!.shelf.map((book) => book.slug)).toEqual(['book-of-ash']);
		expect((await publicUniverse(db, 'inkwright', universeId))?.name).toBe('The Ember Reach');
		// Nothing of the universe but its name and address.
		expect(Object.keys(page!).sort()).toEqual(['id', 'name', 'shelf', 'slug']);
	});

	it("lists only that universe's stories", async () => {
		await publishStory(db, authorId, storyId);
		const [other] = await db
			.insert(universes)
			.values({ ownerId: authorId, name: 'Far Shore', slug: 'far-shore' })
			.returning();
		await addPublishedStory(other.id, 'Tide', 'tide', 'public');

		const ember = await publicUniverse(db, 'inkwright', 'ember-reach');
		const far = await publicUniverse(db, 'inkwright', 'far-shore');
		expect(ember!.shelf.map((book) => book.slug)).toEqual(['book-of-ash']);
		expect(far!.shelf.map((book) => book.slug)).toEqual(['tide']);
	});

	it('is not found until something in it is listed', async () => {
		expect(await publicUniverse(db, 'inkwright', 'ember-reach')).toBeNull();
		await db.update(stories).set({ visibility: 'unlisted' }).where(eq(stories.id, storyId));
		await publishStory(db, authorId, storyId);
		expect(await publicUniverse(db, 'inkwright', 'ember-reach')).toBeNull();
		await db.update(stories).set({ visibility: 'public' }).where(eq(stories.id, storyId));
		expect(await publicUniverse(db, 'inkwright', 'ember-reach')).not.toBeNull();

		const [current] = (await allEditions()).filter((row) => row.isCurrent);
		await takedownPublication(db, current.id, null, 'other');
		expect(await publicUniverse(db, 'inkwright', 'ember-reach')).toBeNull();
	});

	it('never shows the hidden home of one-off stories', async () => {
		await db.update(universes).set({ standalone: true }).where(eq(universes.id, universeId));
		await publishStory(db, authorId, storyId);
		expect(await publicUniverse(db, 'inkwright', 'ember-reach')).toBeNull();
		expect(await publicUniverse(db, 'inkwright', universeId)).toBeNull();
	});

	it('is scoped to the handle', async () => {
		await publishStory(db, authorId, storyId);
		const { rivalUniverseId } = await addRival({ withStory: false });
		// The rival's same-slug universe has nothing listed; inkwright's does.
		expect(await publicUniverse(db, 'rival', 'ember-reach')).toBeNull();
		expect(await publicUniverse(db, 'rival', universeId)).toBeNull();
		expect(await publicUniverse(db, 'inkwright', rivalUniverseId)).toBeNull();
		expect((await publicUniverse(db, 'inkwright', 'ember-reach'))?.id).toBe(universeId);
	});

	it('links a story to its universe page only while that page exists', async () => {
		expect(await publicUniverseLink(db, 'inkwright', universeId)).toBeNull();
		await publishStory(db, authorId, storyId);
		expect(await publicUniverseLink(db, 'inkwright', universeId)).toEqual({
			name: 'The Ember Reach',
			slug: 'ember-reach'
		});
		expect(await publicUniverseLink(db, 'rival', universeId)).toBeNull();
		await db.update(stories).set({ visibility: 'unlisted' }).where(eq(stories.id, storyId));
		expect(await publicUniverseLink(db, 'inkwright', universeId)).toBeNull();
		await db.update(stories).set({ visibility: 'public' }).where(eq(stories.id, storyId));
		await db.update(universes).set({ standalone: true }).where(eq(universes.id, universeId));
		expect(await publicUniverseLink(db, 'inkwright', universeId)).toBeNull();
	});

	it('lets a story and a universe share a slug, each at its own address', async () => {
		await db.update(stories).set({ slug: 'ember-reach' }).where(eq(stories.id, storyId));
		await publishStory(db, authorId, storyId);
		expect((await publicEdition(db, 'inkwright', 'ember-reach'))?.storyId).toBe(storyId);
		expect((await publicUniverse(db, 'inkwright', 'ember-reach'))?.id).toBe(universeId);
	});
});

describe('suspended author', () => {
	it('hides every public page and file until the suspension is lifted', async () => {
		await db
			.update(universes)
			.set({ name: 'The Ember Reach', slug: 'ember-reach' })
			.where(eq(universes.id, universeId));
		const coverId = crypto.randomUUID();
		await db
			.update(stories)
			.set({ slug: 'book-of-ash', coverAssetId: coverId })
			.where(eq(stories.id, storyId));
		const [image] = await db
			.insert(assets)
			.values({
				ownerId: authorId,
				universeId,
				kind: 'inline',
				filename: 'map.png',
				contentType: 'image/png',
				byteSize: 8,
				storageKey: 'codex-assets/map'
			})
			.returning();
		const avatarId = crypto.randomUUID();
		await db
			.update(users)
			.set({ profilePublic: true, avatarAssetId: avatarId })
			.where(eq(users.id, authorId));
		const published = await publishStory(db, authorId, storyId);
		if (!published.ok) throw new Error(published.reason);
		await db
			.update(publications)
			.set({ downloadsPublic: true })
			.where(eq(publications.id, published.publicationId));
		await db.insert(publicationAssets).values({
			publicationId: published.publicationId,
			assetId: image.id
		});
		const [artifact] = await db
			.insert(exportArtifacts)
			.values({
				publicationId: published.publicationId,
				format: 'epub',
				storageKey: 'codex-exports/book.epub',
				filename: 'book.epub',
				contentType: 'application/epub+zip',
				byteSize: 10
			})
			.returning();
		await db.insert(slugHistory).values([
			{ ownerId: authorId, kind: 'story', slug: 'old-ash', storyId },
			{ ownerId: authorId, kind: 'universe', slug: 'old-reach', universeId }
		]);

		const visible = async () => ({
			shelf: (await publicShelf(db, 'inkwright')).length > 0,
			profile: (await publicProfile(db, 'inkwright')) !== null,
			identity: (await publicAuthorIdentity(db, 'inkwright')) !== null,
			bySlug: (await publicEdition(db, 'inkwright', 'book-of-ash')) !== null,
			byId: (await publicEdition(db, 'inkwright', storyId)) !== null,
			universe: (await publicUniverse(db, 'inkwright', 'ember-reach')) !== null,
			universeLink: (await publicUniverseLink(db, 'inkwright', universeId)) !== null,
			storyRedirect: (await publicStoryRedirect(db, 'inkwright', 'old-ash')) !== null,
			universeRedirect: (await publicUniverseRedirect(db, 'inkwright', 'old-reach')) !== null,
			cover: await isPublicAsset(db, coverId),
			image: await isPublicAsset(db, image.id),
			avatar: await isPublicAvatar(db, avatarId),
			download: (await artifactForDownload(db, artifact.id, null)) !== null,
			readingPage: (await readingPageRef(db, storyId)) !== null
		});
		const everything = (value: boolean) =>
			Object.fromEntries(Object.keys(VISIBLE_KEYS).map((key) => [key, value]));
		const VISIBLE_KEYS = await visible();
		expect(VISIBLE_KEYS).toEqual(everything(true));

		await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, authorId));
		expect(await visible()).toEqual(everything(false));
		// The author keeps their own download.
		expect(await artifactForDownload(db, artifact.id, authorId)).not.toBeNull();

		await db.update(users).set({ suspendedAt: null }).where(eq(users.id, authorId));
		expect(await visible()).toEqual(everything(true));
	});
});
