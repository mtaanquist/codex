import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	publications,
	scenes,
	slugHistory,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { uniqueSlug } from '../../src/lib/server/slugs';
import { saveStoryDetails, type StoryDetails } from '../../src/lib/server/story-details';
import { saveUniverseDetails } from '../../src/lib/server/universe-details';
import { createStoryInUniverse } from '../../src/lib/server/story-create';
import { restoreStory, trashStory } from '../../src/lib/server/story-lifecycle';
import { purgeStory } from '../../src/lib/server/story-delete';
import { purgeAccount } from '../../src/lib/server/account-deletion';
import {
	publicStoryRedirect,
	publicUniverseRedirect,
	publishStory,
	takedownPublication
} from '../../src/lib/server/publish';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let otherId: string;
let universeId: string;
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table slug_history, publication_assets, publications, scenes, chapters, stories, universes, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({
			email: 'hist@example.com',
			displayName: 'H',
			passwordHash: 'x',
			role: 'user',
			handle: 'inkwright',
			publicArchiveEnabled: true
		})
		.returning();
	ownerId = owner.id;
	const [other] = await db
		.insert(users)
		.values({
			email: 'hist2@example.com',
			displayName: 'H2',
			passwordHash: 'x',
			role: 'user',
			handle: 'rival',
			publicArchiveEnabled: true
		})
		.returning();
	otherId = other.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Ember Reach', slug: 'ember-reach' })
		.returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'Ember', slug: 'ember', visibility: 'public' })
		.returning();
	storyId = story.id;
	await db.insert(scenes).values({ storyId, globalPosition: 1, bodyMd: 'The gate opened.' });
});

afterAll(async () => {
	await pool.end();
});

const details = (title: string): StoryDetails => ({
	title,
	author: null,
	brief: null,
	descriptionMd: null,
	styleNotes: null,
	coverColor: null
});

async function renameStory(id: string, title: string) {
	const [story] = await db.select().from(stories).where(eq(stories.id, id));
	return saveStoryDetails(db, ownerId, story, details(title));
}

async function renameUniverse(title: string) {
	const [universe] = await db.select().from(universes).where(eq(universes.id, universeId));
	return saveUniverseDetails(db, ownerId, universe, {
		name: title,
		descriptionMd: null,
		establishedSetting: false
	});
}

// A published story with a scene, so it can be renamed into history.
async function publishedStory(title: string) {
	const story = await createStoryInUniverse(db, ownerId, universeId, title);
	await db.insert(scenes).values({ storyId: story.id, globalPosition: 1, bodyMd: 'Words.' });
	const published = await publishStory(db, ownerId, story.id);
	if (!published.ok) throw new Error(published.reason);
	return story;
}

describe('a story renamed before it was published', () => {
	it('reserves nothing, since no public link can name the old slug', async () => {
		expect(await renameStory(storyId, 'Ember Rising')).toBe('ember-rising');
		expect(await db.select().from(slugHistory)).toEqual([]);
		expect((await createStoryInUniverse(db, ownerId, universeId, 'Ember')).slug).toBe('ember');
	});
});

describe('a rename that keeps the slug base', () => {
	it('keeps its suffixed slug rather than moving to a lower one that came free', async () => {
		const [third] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Ember', slug: 'ember-3' })
			.returning();
		expect(await renameStory(third.id, 'EMBER!')).toBe('ember-3');
		expect(await db.select().from(slugHistory)).toEqual([]);
	});

	it('still moves when the base changes', async () => {
		const [third] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Ember', slug: 'ember-3' })
			.returning();
		expect(await renameStory(third.id, 'Ash')).toBe('ash');
	});
});

describe('reserving old slugs', () => {
	beforeEach(async () => {
		await publishStory(db, ownerId, storyId);
	});

	it('keeps the slug a rename moves off, for that story', async () => {
		expect(await renameStory(storyId, 'Ember Rising')).toBe('ember-rising');
		const rows = await db.select().from(slugHistory);
		expect(rows).toMatchObject([{ ownerId, kind: 'story', slug: 'ember', storyId }]);
	});

	it('never hands a reserved slug to a new story or a rename', async () => {
		await renameStory(storyId, 'Ember Rising');
		const created = await createStoryInUniverse(db, ownerId, universeId, 'Ember');
		expect(created.slug).toBe('ember-2');
		const [second] = await db
			.insert(stories)
			.values({ universeId, ownerId, title: 'Other', slug: 'other' })
			.returning();
		expect(await renameStory(second.id, 'Ember')).toBe('ember-3');
	});

	it('lets a story take back its own old slug, which stops being history', async () => {
		await renameStory(storyId, 'Ember Rising');
		expect(await renameStory(storyId, 'Ember')).toBe('ember');
		const rows = await db.select().from(slugHistory);
		expect(rows.map((row) => row.slug)).toEqual(['ember-rising']);
	});

	it('is per account and per kind', async () => {
		await renameStory(storyId, 'Ember Rising');
		expect(await uniqueSlug(db, 'stories', otherId, 'Ember', 'story')).toBe('ember');
		// A universe can still be called what a story used to be.
		expect(await uniqueSlug(db, 'universes', ownerId, 'Ember', 'universe')).toBe('ember');
	});

	it('works the same for universes', async () => {
		expect(await renameUniverse('Far Shore')).toBe('far-shore');
		expect(await uniqueSlug(db, 'universes', ownerId, 'Ember Reach', 'universe')).toBe(
			'ember-reach-2'
		);
		expect(await renameUniverse('Ember Reach')).toBe('ember-reach');
	});

	it('keeps the reservation after the story is purged', async () => {
		await renameStory(storyId, 'Ember Rising');
		await purgeStory(db, storyId);
		const [row] = await db.select().from(slugHistory);
		expect(row).toMatchObject({ slug: 'ember', storyId: null });
		expect(await uniqueSlug(db, 'stories', ownerId, 'Ember', 'story')).toBe('ember-2');
	});

	it('moves a restored story off a slug another story reserved meanwhile', async () => {
		await trashStory(db, ownerId, storyId);
		const taker = await publishedStory('Ember');
		expect(taker.slug).toBe('ember');
		await renameStory(taker.id, 'Cinder');
		await restoreStory(db, ownerId, storyId);
		const [restored] = await db.select().from(stories).where(eq(stories.id, storyId));
		expect(restored.slug).toBe('ember-2');
	});

	it('comes back as current when a restore lands on its own old slug', async () => {
		await renameStory(storyId, 'Ember Rising');
		await trashStory(db, ownerId, storyId);
		// Something else takes its live slug, so the restore picks from its
		// title, which is now free only as its own old slug.
		await db.insert(stories).values({ universeId, ownerId, title: 'Taker', slug: 'ember-rising' });
		await db.update(stories).set({ title: 'Ember' }).where(eq(stories.id, storyId));
		await restoreStory(db, ownerId, storyId);
		const [restored] = await db.select().from(stories).where(eq(stories.id, storyId));
		expect(restored.slug).toBe('ember');
		expect(await db.select().from(slugHistory)).toEqual([]);
	});

	it('records each slug when one story is renamed twice at once', async () => {
		await Promise.all([renameStory(storyId, 'Ember Rising'), renameStory(storyId, 'Cinder')]);
		const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
		const slugs = (await db.select().from(slugHistory)).map((row) => row.slug).sort();
		// Whichever landed second moved off the first one's slug, not the stale one.
		const other = story.slug === 'cinder' ? 'ember-rising' : 'cinder';
		expect(slugs).toEqual([other, 'ember'].sort());
	});

	it('keeps the slug with the title when a save read an older title', async () => {
		// The settings page loaded with 'Ember'; meanwhile another tab renamed
		// it. Saving the old form puts 'Ember' back, and the slug follows.
		const [stale] = await db.select().from(stories).where(eq(stories.id, storyId));
		await renameStory(storyId, 'Cinder');
		expect(await saveStoryDetails(db, ownerId, stale, details('Ember'))).toBe('ember');
		const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
		expect(story).toMatchObject({ title: 'Ember', slug: 'ember' });
	});

	it('reserves a universe slug even after its published stories are purged', async () => {
		await purgeStory(db, storyId);
		await renameUniverse('Far Shore');
		expect(await uniqueSlug(db, 'universes', ownerId, 'Ember Reach', 'universe')).toBe(
			'ember-reach-2'
		);
	});

	it('goes with the account', async () => {
		await renameStory(storyId, 'Ember Rising');
		await purgeAccount(db, ownerId, null);
		expect(await db.select().from(slugHistory)).toEqual([]);
	});
});

describe('public redirects from old slugs', () => {
	it('sends an old story slug to the current one while it is public', async () => {
		await publishStory(db, ownerId, storyId);
		await renameStory(storyId, 'Ember Rising');
		expect(await publicStoryRedirect(db, 'inkwright', 'ember')).toBe('ember-rising');
		// Two renames on, the first slug still lands on the current one.
		await renameStory(storyId, 'Ember Falling');
		expect(await publicStoryRedirect(db, 'inkwright', 'ember')).toBe('ember-falling');
		expect(await publicStoryRedirect(db, 'inkwright', 'ember-rising')).toBe('ember-falling');
	});

	it('is scoped to the handle', async () => {
		await publishStory(db, ownerId, storyId);
		await renameStory(storyId, 'Ember Rising');
		expect(await publicStoryRedirect(db, 'rival', 'ember')).toBeNull();
		expect(await publicStoryRedirect(db, 'inkwright', 'never-was')).toBeNull();
	});

	it('never redirects to a story that is not readable at its slug', async () => {
		const published = await publishStory(db, ownerId, storyId);
		if (!published.ok) throw new Error(published.reason);
		await renameStory(storyId, 'Ember Rising');

		// Unlisted: the redirect would give its id away.
		await db.update(stories).set({ visibility: 'unlisted' }).where(eq(stories.id, storyId));
		expect(await publicStoryRedirect(db, 'inkwright', 'ember')).toBeNull();
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect(await publicStoryRedirect(db, 'inkwright', 'ember')).toBeNull();
		await db.update(stories).set({ visibility: 'public' }).where(eq(stories.id, storyId));
		expect(await publicStoryRedirect(db, 'inkwright', 'ember')).toBe('ember-rising');

		await trashStory(db, ownerId, storyId);
		expect(await publicStoryRedirect(db, 'inkwright', 'ember')).toBeNull();
		await restoreStory(db, ownerId, storyId);
		expect(await publicStoryRedirect(db, 'inkwright', 'ember')).toBe('ember-rising');

		await takedownPublication(db, published.publicationId);
		expect(await publicStoryRedirect(db, 'inkwright', 'ember')).toBeNull();
	});

	it('404s once the story is purged', async () => {
		await publishStory(db, ownerId, storyId);
		await renameStory(storyId, 'Ember Rising');
		await db.delete(publications).where(eq(publications.storyId, storyId));
		await purgeStory(db, storyId);
		expect(await publicStoryRedirect(db, 'inkwright', 'ember')).toBeNull();
	});

	it('sends an old universe slug to the current one while its page shows', async () => {
		await publishStory(db, ownerId, storyId);
		await renameUniverse('Far Shore');
		expect(await publicUniverseRedirect(db, 'inkwright', 'ember-reach')).toBe('far-shore');
		// Nothing listed in it: no page, so no redirect.
		await db.update(stories).set({ visibility: 'unlisted' }).where(eq(stories.id, storyId));
		expect(await publicUniverseRedirect(db, 'inkwright', 'ember-reach')).toBeNull();
		await db.update(stories).set({ visibility: 'public' }).where(eq(stories.id, storyId));
		expect(await publicUniverseRedirect(db, 'rival', 'ember-reach')).toBeNull();
		await db.update(universes).set({ deletedAt: new Date() }).where(eq(universes.id, universeId));
		expect(await publicUniverseRedirect(db, 'inkwright', 'ember-reach')).toBeNull();
	});
});
