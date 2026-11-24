import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The language and spelling convention on a universe and a story, and the
// writer's native language, saved through the settings forms and read back
// the way the Assistant's prompts read them.

vi.mock('#lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { createStoryInUniverse, standaloneUniverse } =
	await import('../../src/lib/server/story-create');
const { storyLanguage, universeLanguage, workLanguage } =
	await import('../../src/lib/server/language');
const universePage = await import('../../src/routes/universes/[id]/[[section]]/+page.server');
const storySettings =
	await import('../../src/routes/stories/[id]/settings/[[section]]/+page.server');
const accountPage = await import('../../src/routes/account/[[section]]/+page.server');

let user: { id: string; displayName: string };
let otherId: string;
let universeId: string;
let storyId: string;

function post(fields: Record<string, string>, params: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://localhost/', { method: 'POST', body }),
		params,
		locals: { user, session: null }
	} as never;
}

const saveUniverse = (language: string) =>
	universePage.actions.update(post({ name: 'Ardenfall', language }, { id: universeId }));
const saveStory = (language: string) =>
	storySettings.actions.update(post({ title: 'The Toll', language }, { id: storyId }));

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table stories, universes, users cascade');
	[user] = await db
		.insert(users)
		.values({ email: 'lang@example.com', displayName: 'L', passwordHash: 'x', role: 'user' })
		.returning();
	const [other] = await db
		.insert(users)
		.values({ email: 'other@example.com', displayName: 'O', passwordHash: 'x', role: 'user' })
		.returning();
	otherId = other.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: user.id, name: 'Ardenfall', slug: 'ardenfall' })
		.returning();
	universeId = universe.id;
	storyId = (await createStoryInUniverse(db, user.id, universe.id, 'The Toll')).id;
});

afterAll(async () => {
	await pool.end();
});

describe('the language settings', () => {
	it('starts unset, so nothing is stated', async () => {
		expect(await storyLanguage(db, storyId)).toEqual({ language: null, native: null });
		expect(await universeLanguage(db, universeId)).toEqual({ language: null, native: null });
	});

	it('saves the universe language, and a story uses it until it picks its own', async () => {
		expect(await saveUniverse('en-GB')).toMatchObject({ saved: true });
		expect((await storyLanguage(db, storyId)).language).toBe('en-GB');

		expect(await saveStory('en-US')).toMatchObject({ saved: true });
		expect((await storyLanguage(db, storyId)).language).toBe('en-US');
		expect((await universeLanguage(db, universeId)).language).toBe('en-GB');

		// Back to the universe's, then to not set at all.
		await saveStory('');
		expect((await storyLanguage(db, storyId)).language).toBe('en-GB');
		await saveUniverse('');
		expect((await storyLanguage(db, storyId)).language).toBeNull();
	});

	it('refuses a language that is not on the list and keeps what was there', async () => {
		await saveUniverse('da');
		expect(await saveUniverse('klingon')).toMatchObject({ status: 400 });
		expect(await saveStory('xx-YY')).toMatchObject({ status: 400 });
		const [row] = await db
			.select({ universe: universes.language })
			.from(universes)
			.where(eq(universes.id, universeId));
		expect(row.universe).toBe('da');
		const [story] = await db
			.select({ language: stories.language })
			.from(stories)
			.where(eq(stories.id, storyId));
		expect(story.language).toBeNull();
	});

	it('keeps the stored languages when a details form leaves the field out', async () => {
		await saveUniverse('en-GB');
		await saveStory('en-US');
		expect(
			await universePage.actions.update(post({ name: 'Ardenfall' }, { id: universeId }))
		).toMatchObject({ saved: true });
		expect(
			await storySettings.actions.update(post({ title: 'The Toll' }, { id: storyId }))
		).toMatchObject({ saved: true });
		expect((await universeLanguage(db, universeId)).language).toBe('en-GB');
		expect((await storyLanguage(db, storyId)).language).toBe('en-US');
	});

	it("saves the writer's native language from the profile form", async () => {
		const save = (nativeLanguage: string) =>
			accountPage.actions.updateName(post({ displayName: 'L', penName: '', nativeLanguage }, {}));
		expect(await save('da')).toMatchObject({ saved: true });
		await saveUniverse('en-GB');
		expect(await storyLanguage(db, storyId)).toEqual({ language: 'en-GB', native: 'da' });
		expect(await save('nope')).toMatchObject({ status: 400 });
		await save('');
		expect((await storyLanguage(db, storyId)).native).toBeNull();
	});

	it('keeps the native language when the name form leaves the field out', async () => {
		const save = (fields: Record<string, string>) =>
			accountPage.actions.updateName(post({ displayName: 'L', penName: '', ...fields }, {}));
		await save({ nativeLanguage: 'da' });
		expect(await save({})).toMatchObject({ saved: true });
		const [row] = await db
			.select({ native: users.nativeLanguage })
			.from(users)
			.where(eq(users.id, user.id));
		expect(row.native).toBe('da');
	});

	it("gives a standalone story its universe's language, and says so in Details", async () => {
		const standalone = await standaloneUniverse(db, user.id);
		const loose = await createStoryInUniverse(db, user.id, standalone.id, 'Loose Leaf');
		await universePage.actions.update(
			post({ name: standalone.name, language: 'en-US' }, { id: standalone.id })
		);
		expect((await storyLanguage(db, loose.id)).language).toBe('en-US');
		const data = (await storySettings.load({
			params: { id: loose.id },
			locals: { user, session: null }
		} as never)) as { universe: { language: string | null } };
		expect(data.universe.language).toBe('en-US');
	});

	it("reads nothing of another writer's work", async () => {
		await saveUniverse('en-GB');
		expect(await workLanguage(db, otherId, { storyId })).toEqual({
			language: null,
			native: null
		});
		expect((await workLanguage(db, otherId, { universeId })).language).toBeNull();
		expect((await workLanguage(db, user.id, { universeId })).language).toBe('en-GB');
		expect((await workLanguage(db, user.id, { storyId: 'not-an-id' })).language).toBeNull();
		expect((await workLanguage(db, user.id, { storyId: ` ${storyId} ` })).language).toBe('en-GB');
	});

	it('reads nothing of a story in a trashed universe', async () => {
		await saveUniverse('en-GB');
		await db.update(universes).set({ deletedAt: new Date() }).where(eq(universes.id, universeId));
		expect((await storyLanguage(db, storyId)).language).toBeNull();
	});

	it('gives an app nothing for a story the Assistant is muted on', async () => {
		await saveUniverse('en-GB');
		await db
			.update(stories)
			.set({ llmConfig: { enabled: false } } as Partial<typeof stories.$inferInsert>)
			.where(eq(stories.id, storyId));
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 1, title: 'One', bodyMd: '' })
			.returning({ id: scenes.id });
		expect((await workLanguage(db, user.id, { storyId })).language).toBeNull();
		expect((await workLanguage(db, user.id, { sceneId: scene.id })).language).toBeNull();
		// The app's own surfaces check the mute themselves.
		expect((await storyLanguage(db, storyId, user.id)).language).toBe('en-GB');
	});

	it('reads nothing of a trashed scene', async () => {
		await saveUniverse('en-GB');
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 1, title: 'One', bodyMd: '' })
			.returning({ id: scenes.id });
		expect((await workLanguage(db, user.id, { sceneId: scene.id })).language).toBe('en-GB');
		await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, scene.id));
		expect((await workLanguage(db, user.id, { sceneId: scene.id })).language).toBeNull();
	});
});
