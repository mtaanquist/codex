import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { NO_PREFERENCES, MAX_ASSISTANT_NOTES } from '../../src/lib/assistant-preferences';
import { ensureTestDatabase } from './test-db';

// The Assistant preferences on a universe and a story, saved through the
// settings forms and read back the way the Assistant's prompts read them.

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
const { createStoryInUniverse } = await import('../../src/lib/server/story-create');
const { storyPreferences, universePreferences, workPreferences } =
	await import('../../src/lib/server/assistant-preferences');
const universePage = await import('../../src/routes/universes/[id]/[[section]]/+page.server');
const storySettings =
	await import('../../src/routes/stories/[id]/settings/[[section]]/+page.server');

let user: { id: string; displayName: string };
let other: { id: string; displayName: string };
let universeId: string;
let storyId: string;

function post(
	fields: Record<string, string>,
	params: Record<string, string>,
	as: { id: string; displayName: string } = user
) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://localhost/', { method: 'POST', body }),
		params,
		locals: { user: as, session: null }
	} as never;
}

const saveUniverse = (fields: Record<string, string>) =>
	universePage.actions.saveAssistantPreferences(post(fields, { id: universeId }));
const saveStory = (fields: Record<string, string>) =>
	storySettings.actions.saveAssistantPreferences(post(fields, { id: storyId }));

async function stored() {
	const [story] = await db
		.select({ preferences: stories.assistantPreferences, notes: stories.assistantNotes })
		.from(stories)
		.where(eq(stories.id, storyId));
	return story;
}

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table stories, universes, users cascade');
	[user] = await db
		.insert(users)
		.values({ email: 'prefs@example.com', displayName: 'P', passwordHash: 'x', role: 'user' })
		.returning();
	[other] = await db
		.insert(users)
		.values({ email: 'other@example.com', displayName: 'O', passwordHash: 'x', role: 'user' })
		.returning();
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

describe('the assistant preferences', () => {
	it('starts unset, so nothing is stated', async () => {
		expect(await storyPreferences(db, storyId)).toEqual(NO_PREFERENCES);
		expect(await universePreferences(db, universeId)).toEqual(NO_PREFERENCES);
		expect(await stored()).toEqual({ preferences: {}, notes: null });
	});

	it('saves the universe default, and a story overrides it key by key', async () => {
		expect(
			await saveUniverse({
				quoteMarks: 'single',
				tense: 'past',
				filterVerbs: 'leave',
				assistantNotes: 'Universe habits.'
			})
		).toMatchObject({ action: 'assistant-preferences', saved: true });
		let setting = await storyPreferences(db, storyId);
		expect(setting.houseStyle).toMatchObject({ quoteMarks: 'single', tense: 'past' });
		expect(setting.leaveAlone).toEqual(['filterVerbs']);
		expect(setting.notes).toBe('Universe habits.');

		expect(
			await saveStory({ tense: 'present', filterVerbs: 'check', epithets: 'leave' })
		).toMatchObject({ saved: true });
		setting = await storyPreferences(db, storyId);
		expect(setting.houseStyle).toMatchObject({ quoteMarks: 'single', tense: 'present' });
		expect(setting.leaveAlone).toEqual(['epithets']);
		expect(setting.notes).toBe('Universe habits.');
		expect(await stored()).toEqual({
			preferences: { tense: 'present', filterVerbs: 'check', epithets: 'leave' },
			notes: null
		});

		// A blank form puts the story back on the universe's.
		await saveStory({ assistantNotes: '  ' });
		expect(await stored()).toEqual({ preferences: {}, notes: null });
		expect((await storyPreferences(db, storyId)).houseStyle.tense).toBe('past');
	});

	it('refuses a value off its list or notes over the cap, and keeps what was there', async () => {
		await saveStory({ narration: 'first', assistantNotes: 'Mine.' });
		expect(await saveStory({ narration: 'second', assistantNotes: 'Typed.' })).toMatchObject({
			status: 400,
			data: { submitted: { narration: 'second', assistantNotes: 'Typed.' } }
		});
		expect(await saveStory({ repetition: 'sometimes' })).toMatchObject({ status: 400 });
		expect(await saveStory({ assistantNotes: 'x'.repeat(MAX_ASSISTANT_NOTES + 1) })).toMatchObject({
			status: 400
		});
		expect(await saveUniverse({ serialComma: 'maybe' })).toMatchObject({ status: 400 });
		expect(await stored()).toEqual({ preferences: { narration: 'first' }, notes: 'Mine.' });
	});

	it("cannot save or read another writer's work", async () => {
		await saveStory({ quoteMarks: 'double' });
		await expect(
			storySettings.actions.saveAssistantPreferences(
				post({ quoteMarks: 'single' }, { id: storyId }, other)
			)
		).rejects.toMatchObject({ status: 404 });
		await expect(
			universePage.actions.saveAssistantPreferences(
				post({ quoteMarks: 'single' }, { id: universeId }, other)
			)
		).rejects.toMatchObject({ status: 404 });
		expect((await stored()).preferences).toEqual({ quoteMarks: 'double' });

		expect(await workPreferences(db, other.id, { storyId })).toEqual(NO_PREFERENCES);
		expect(await workPreferences(db, other.id, { universeId })).toEqual(NO_PREFERENCES);
		expect((await workPreferences(db, user.id, { storyId })).houseStyle.quoteMarks).toBe('double');
		expect(await workPreferences(db, user.id, { storyId: 'not-an-id' })).toEqual(NO_PREFERENCES);
		expect(
			(await workPreferences(db, user.id, { storyId: ` ${storyId} ` })).houseStyle.quoteMarks
		).toBe('double');
	});

	it('reads nothing of a story in a trashed universe', async () => {
		await saveStory({ quoteMarks: 'double' });
		await db.update(universes).set({ deletedAt: new Date() }).where(eq(universes.id, universeId));
		expect(await storyPreferences(db, storyId)).toEqual(NO_PREFERENCES);
	});

	it('gives an app nothing for a story the Assistant is muted on', async () => {
		await saveStory({ quoteMarks: 'double' });
		await db
			.update(stories)
			.set({ llmConfig: { enabled: false } } as Partial<typeof stories.$inferInsert>)
			.where(eq(stories.id, storyId));
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 1, title: 'One', bodyMd: '' })
			.returning({ id: scenes.id });
		expect(await workPreferences(db, user.id, { storyId })).toEqual(NO_PREFERENCES);
		expect(await workPreferences(db, user.id, { sceneId: scene.id })).toEqual(NO_PREFERENCES);
		// The app's own surfaces check the mute themselves.
		expect((await storyPreferences(db, storyId, user.id)).houseStyle.quoteMarks).toBe('double');
	});
});
