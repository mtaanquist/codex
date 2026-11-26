import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { scenes, stories, tags, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import {
	ASSISTANT_CHOICES,
	HABIT_CHECKS,
	HOUSE_STYLE,
	MAX_ASSISTANT_NOTES,
	NO_PREFERENCES
} from '../../src/lib/assistant-preferences';
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
const { createStoryInUniverse, standaloneUniverse } =
	await import('../../src/lib/server/story-create');
const { storyAssistantPreferences, universePreferences, workPreferences } =
	await import('../../src/lib/server/assistant-preferences');
const { saveMcpInstanceEnabled } = await import('../../src/lib/server/mcp/settings');
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

// Every field as the page posts it with nothing chosen.
const blankForm = Object.fromEntries(
	[
		...HOUSE_STYLE,
		...HABIT_CHECKS,
		...ASSISTANT_CHOICES,
		{ key: 'draftWords' },
		{ key: 'assistantNotes' }
	].map(({ key }) => [key, ''])
);

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
	await pool.query('truncate table stories, universes, users, tags cascade');
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
	it("lets a story turn off its universe's notes, and not a universe", async () => {
		await saveUniverse({ assistantNotes: 'Universe habits.', useUniverseNotes: 'no' });
		expect((await storyAssistantPreferences(db, storyId)).notes).toBe('Universe habits.');
		expect(await saveStory({ useUniverseNotes: 'no' })).toMatchObject({ saved: true });
		expect((await storyAssistantPreferences(db, storyId)).notes).toBeNull();
		expect(await saveStory({ useUniverseNotes: '' })).toMatchObject({ saved: true });
		expect((await storyAssistantPreferences(db, storyId)).notes).toBe('Universe habits.');
		const [universe] = await db
			.select({ preferences: universes.assistantPreferences })
			.from(universes)
			.innerJoin(stories, eq(stories.universeId, universes.id))
			.where(eq(stories.id, storyId));
		expect(universe.preferences).toEqual({});
	});

	it('starts unset, so nothing is stated', async () => {
		expect(await storyAssistantPreferences(db, storyId)).toEqual(NO_PREFERENCES);
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
		let setting = await storyAssistantPreferences(db, storyId);
		expect(setting.houseStyle).toMatchObject({ quoteMarks: 'single', tense: 'past' });
		expect(setting.leaveAlone).toEqual(['filterVerbs']);
		expect(setting.notes).toBe('Universe habits.');

		expect(
			await saveStory({ tense: 'present', filterVerbs: 'check', epithets: 'leave' })
		).toMatchObject({ saved: true });
		setting = await storyAssistantPreferences(db, storyId);
		expect(setting.houseStyle).toMatchObject({ quoteMarks: 'single', tense: 'present' });
		expect(setting.leaveAlone).toEqual(['epithets']);
		expect(setting.notes).toBe('Universe habits.');
		expect(await stored()).toEqual({
			preferences: { tense: 'present', filterVerbs: 'check', epithets: 'leave' },
			notes: null
		});

		// A blank form puts the story back on the universe's.
		await saveStory(blankForm);
		expect(await stored()).toEqual({ preferences: {}, notes: null });
		expect((await storyAssistantPreferences(db, storyId)).houseStyle.tense).toBe('past');
	});

	it('saves feedback, length and content limits, naming each warning from the live list', async () => {
		const [gore, language, gone] = await db
			.insert(tags)
			.values([
				{ kind: 'warning', name: 'Gore', slug: 'gore' },
				{ kind: 'warning', name: 'Strong language', slug: 'strong-language' },
				{ kind: 'warning', name: 'Old', slug: 'old' }
			])
			.returning();
		expect(
			await saveUniverse({
				feedback: 'thorough',
				summaryLength: 'detailed',
				draftWords: '1500',
				'warning:gore': 'avoid',
				'warning:strong-language': 'write',
				'warning:old': 'avoid',
				// Not on the list, so not read.
				'warning:made-up': 'avoid'
			})
		).toMatchObject({ saved: true });
		expect(
			await saveStory({ feedback: 'sparing', editReasons: 'never', 'warning:gore': 'write' })
		).toMatchObject({ saved: true });
		await db.update(tags).set({ removedAt: new Date() }).where(eq(tags.id, gone.id));
		const setting = await storyAssistantPreferences(db, storyId);
		expect(setting).toMatchObject({
			feedback: 'sparing',
			editReasons: 'never',
			summaryLength: 'detailed',
			draftWords: 1500,
			contentLimits: [
				{ name: gore.name, limit: 'write' },
				{ name: language.name, limit: 'write' }
			]
		});
		const [row] = await db
			.select({ preferences: universes.assistantPreferences })
			.from(universes)
			.where(eq(universes.id, universeId));
		expect(row.preferences).not.toHaveProperty('warning:made-up');
		expect((await universePreferences(db, universeId)).contentLimits).toEqual([
			{ name: 'Gore', limit: 'avoid' },
			{ name: 'Strong language', limit: 'write' }
		]);
		expect(await saveStory({ draftWords: '20000' })).toMatchObject({ status: 400 });
		// A blank warning clears the story's own limit; one left out of the post is kept.
		await saveStory({ 'warning:gore': '' });
		expect((await stored()).preferences).toEqual({ feedback: 'sparing', editReasons: 'never' });
		await saveStory({ 'warning:strong-language': 'avoid' });
		await saveStory({ feedback: 'normal' });
		expect((await stored()).preferences).toEqual({
			feedback: 'normal',
			editReasons: 'never',
			'warning:strong-language': 'avoid'
		});
	});

	it('gives a standalone story the standalone defaults, and shows them in Details', async () => {
		const standalone = await standaloneUniverse(db, user.id);
		const loose = await createStoryInUniverse(db, user.id, standalone.id, 'Loose Leaf');
		expect(
			await universePage.actions.saveAssistantPreferences(
				post(
					{ tense: 'present', commaSplices: 'leave', assistantNotes: 'Short.' },
					{
						id: standalone.id
					}
				)
			)
		).toMatchObject({ saved: true });
		const setting = await storyAssistantPreferences(db, loose.id);
		expect(setting.houseStyle.tense).toBe('present');
		expect(setting.leaveAlone).toEqual(['commaSplices']);
		expect(setting.notes).toBe('Short.');
		// Details gets what the story inherits, as it does for a story in a universe.
		const data = (await storySettings.load({
			params: { id: loose.slug },
			locals: { user, session: null }
		} as never)) as {
			universe: { standalone: boolean; assistantPreferences: unknown; assistantNotes: string };
		};
		expect(data.universe.standalone).toBe(true);
		expect(data.universe.assistantPreferences).toMatchObject({
			tense: 'present',
			commaSplices: 'leave'
		});
		expect(data.universe.assistantNotes).toBe('Short.');
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
		expect(await storyAssistantPreferences(db, storyId)).toEqual(NO_PREFERENCES);
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
		expect((await storyAssistantPreferences(db, storyId, user.id)).houseStyle.quoteMarks).toBe(
			'double'
		);
	});

	it('keeps a setting the post leaves out, and the notes when their field is missing', async () => {
		await saveStory({
			quoteMarks: 'single',
			tense: 'past',
			epithets: 'leave',
			assistantNotes: 'Mine.'
		});
		expect(await saveStory({ tense: 'present', epithets: '' })).toMatchObject({ saved: true });
		expect(await stored()).toEqual({
			preferences: { quoteMarks: 'single', tense: 'present' },
			notes: 'Mine.'
		});
		await saveUniverse({ serialComma: 'no', assistantNotes: 'U.' });
		await saveUniverse({ thoughts: 'plain' });
		const [row] = await db
			.select({ preferences: universes.assistantPreferences, notes: universes.assistantNotes })
			.from(universes)
			.where(eq(universes.id, universeId));
		expect(row).toEqual({ preferences: { serialComma: 'no', thoughts: 'plain' }, notes: 'U.' });
	});

	it('reads nothing of a trashed scene', async () => {
		await saveStory({ quoteMarks: 'double' });
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 1, title: 'One', bodyMd: '' })
			.returning({ id: scenes.id });
		expect((await workPreferences(db, user.id, { sceneId: scene.id })).houseStyle.quoteMarks).toBe(
			'double'
		);
		await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, scene.id));
		expect(await workPreferences(db, user.id, { sceneId: scene.id })).toEqual(NO_PREFERENCES);
	});

	it('shows the form with the Assistant off only when connected apps are on', async () => {
		const loads = async () => {
			const story = (await storySettings.load({
				params: { id: 'the-toll' },
				locals: { user, session: null }
			} as never)) as { assistantPreferencesShown: boolean; assistantModels: unknown };
			const universe = (await universePage.load({
				params: { id: 'ardenfall' },
				locals: { user, session: null }
			} as never)) as { assistantPreferencesShown: boolean; assistantModels: unknown };
			return [story, universe];
		};
		const instanceDefault = () => pool.query("delete from app_settings where key = 'mcp'");
		await instanceDefault();
		for (const data of await loads()) {
			expect(data.assistantModels).toBeNull();
			expect(data.assistantPreferencesShown).toBe(false);
		}
		// Hidden, the section's own page is not there either.
		await expect(
			storySettings.load({
				params: { id: 'the-toll', section: 'preferences' },
				locals: { user, session: null }
			} as never)
		).rejects.toMatchObject({ status: 404 });
		await expect(
			universePage.load({
				params: { id: 'ardenfall', section: 'preferences' },
				locals: { user, session: null }
			} as never)
		).rejects.toMatchObject({ status: 404 });
		await db.update(users).set({ mcpEnabled: true }).where(eq(users.id, user.id));
		await expect(
			storySettings.load({
				params: { id: 'the-toll', section: 'preferences' },
				locals: { user, session: null }
			} as never)
		).resolves.toMatchObject({ assistantPreferencesShown: true });
		await expect(
			universePage.load({
				params: { id: 'ardenfall', section: 'preferences' },
				locals: { user, session: null }
			} as never)
		).resolves.toMatchObject({ assistantPreferencesShown: true });
		for (const data of await loads()) {
			// The Assistant section stays hidden; the preferences show.
			expect(data.assistantModels).toBeNull();
			expect(data.assistantPreferencesShown).toBe(true);
		}
		// With external access off for the instance, apps get nothing.
		await saveMcpInstanceEnabled(db, false);
		try {
			for (const data of await loads()) expect(data.assistantPreferencesShown).toBe(false);
		} finally {
			await instanceDefault();
		}
	});
});
