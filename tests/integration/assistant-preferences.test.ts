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
import { NO_LANGUAGE } from '../../src/lib/writing-languages';
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
const { savePreferences, storyAssistantPreferences, universePreferences, workPreferences } =
	await import('../../src/lib/server/assistant-preferences');
const { mergeTag, renameTag, setTagRemoved, unmergeTag } =
	await import('../../src/lib/server/tags');
const { reviewSettingsKey } = await import('../../src/lib/server/review-runs');
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
				'warning:old': 'avoid'
			})
		).toMatchObject({ saved: true });
		// Not on the list, so not read.
		expect(await saveUniverse({ 'warning:made-up': 'avoid' })).toMatchObject({ saved: true });
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
			{ id: gore.id, name: 'Gore', limit: 'avoid' },
			{ id: language.id, name: 'Strong language', limit: 'write' }
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

	it('saves a form opened before a merge or a rename, leaving every limit as stored', async () => {
		await db.insert(tags).values([
			{ kind: 'warning', name: 'Gore', slug: 'gore' },
			{ kind: 'warning', name: 'Blood', slug: 'blood' },
			{ kind: 'warning', name: 'Death', slug: 'death' },
			{ kind: 'warning', name: 'Language', slug: 'language' }
		]);
		const tagId = async (slug: string) =>
			(await db.select().from(tags).where(eq(tags.slug, slug)))[0].id;
		// The form as the page showed it: every warning not set but Blood and Death.
		const opened = {
			'warning:gore': '',
			'warning:blood': 'avoid',
			'warning:death': 'avoid',
			'warning:language': ''
		};
		await saveStory(opened);
		await saveUniverse(opened);
		expect(await mergeTag(db, 'warning', await tagId('blood'), 'Gore')).toEqual({ ok: true });
		// Nothing is copied: Gore folds in Blood's limit when it is read.
		expect((await stored()).preferences).toEqual({
			'warning:blood': 'avoid',
			'warning:death': 'avoid'
		});
		expect((await storyAssistantPreferences(db, storyId)).contentLimits).toMatchObject([
			{ name: 'Death', limit: 'avoid' },
			{ name: 'Gore', limit: 'avoid' }
		]);

		const notice = {
			action: 'assistant-preferences',
			saved: true,
			notice:
				'Your other changes are saved. The list of content warnings has changed, so your content limits were not changed. Reload the page to set them.'
		};
		const limitsOf = (preferences: unknown) =>
			Object.fromEntries(
				Object.entries(preferences as Record<string, unknown>).filter(([key]) =>
					key.startsWith('warning:')
				)
			);
		const limitsBefore = limitsOf((await stored()).preferences);
		// After the merge: the old form would clear the "avoid" on Gore and set
		// Language. Neither is written; the notes and the other fields are.
		expect(
			await saveStory({
				...opened,
				'warning:language': 'write',
				tense: 'past',
				assistantNotes: 'Short chapters.'
			})
		).toEqual(notice);
		expect(await stored()).toEqual({
			preferences: { ...limitsBefore, tense: 'past' },
			notes: 'Short chapters.'
		});

		// After a rename too.
		expect(await renameTag(db, 'warning', await tagId('death'), 'Character death')).toEqual({
			ok: true
		});
		const afterRename = limitsOf((await stored()).preferences);
		expect(afterRename).toEqual({
			'warning:blood': 'avoid',
			'warning:character-death': 'avoid'
		});
		const renamedForm = {
			'warning:gore': '',
			'warning:death': '',
			'warning:language': 'avoid',
			tense: 'present',
			assistantNotes: 'Longer chapters.'
		};
		expect(await saveStory(renamedForm)).toEqual(notice);
		expect(await stored()).toEqual({
			preferences: { ...afterRename, tense: 'present' },
			notes: 'Longer chapters.'
		});
		const universeBefore = limitsOf(
			(
				await db
					.select({ preferences: universes.assistantPreferences })
					.from(universes)
					.where(eq(universes.id, universeId))
			)[0].preferences
		);
		expect(await saveUniverse({ ...renamedForm, feedback: 'thorough' })).toEqual(notice);
		const [universe] = await db
			.select({ preferences: universes.assistantPreferences, notes: universes.assistantNotes })
			.from(universes)
			.where(eq(universes.id, universeId));
		expect(universe).toEqual({
			preferences: { ...universeBefore, tense: 'present', feedback: 'thorough' },
			notes: 'Longer chapters.'
		});
		expect((await storyAssistantPreferences(db, storyId)).contentLimits).toEqual([
			{ id: await tagId('character-death'), name: 'Character death', limit: 'avoid' },
			{ id: await tagId('gore'), name: 'Gore', limit: 'avoid' }
		]);

		// A form opened now can clear and set them.
		expect(
			await saveStory({
				'warning:character-death': '',
				'warning:gore': '',
				'warning:language': 'write'
			})
		).toEqual({ action: 'assistant-preferences', saved: true });
		// Blood's own key stays, so undoing the merge gives it back, and while
		// merged it still keeps Gore off the page. Character death now comes
		// from the universe.
		expect((await stored()).preferences).toEqual({
			'warning:blood': 'avoid',
			'warning:language': 'write',
			tense: 'present'
		});
		expect((await storyAssistantPreferences(db, storyId)).contentLimits).toMatchObject([
			{ name: 'Character death', limit: 'avoid' },
			{ name: 'Gore', limit: 'avoid' },
			{ name: 'Language', limit: 'write' }
		]);
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

describe('content limits across merges, renames and removals', () => {
	const tagId = async (slug: string) =>
		(await db.select().from(tags).where(eq(tags.slug, slug)))[0].id;
	const limits = async () =>
		(await storyAssistantPreferences(db, storyId)).contentLimits.map(({ name, limit }) => [
			name,
			limit
		]);
	const allPreferences = async () => ({
		story: (await stored()).preferences,
		universe: (
			await db
				.select({ preferences: universes.assistantPreferences })
				.from(universes)
				.where(eq(universes.id, universeId))
		)[0].preferences
	});

	beforeEach(async () => {
		await db.insert(tags).values([
			{ kind: 'warning', name: 'Gore', slug: 'gore' },
			{ kind: 'warning', name: 'Blood', slug: 'blood' }
		]);
	});

	it("folds an avoid across rows: the universe's on the merged warning beats the story's write", async () => {
		await saveUniverse({ 'warning:blood': 'avoid' });
		await saveStory({ 'warning:gore': 'write' });
		expect(await limits()).toEqual([
			['Blood', 'avoid'],
			['Gore', 'write']
		]);
		expect(await mergeTag(db, 'warning', await tagId('blood'), 'Gore')).toEqual({ ok: true });
		expect(await limits()).toEqual([['Gore', 'avoid']]);
	});

	it('takes a write on the merged warning when the survivor has none', async () => {
		await saveStory({ 'warning:blood': 'write' });
		expect(await mergeTag(db, 'warning', await tagId('blood'), 'Gore')).toEqual({ ok: true });
		expect(await limits()).toEqual([['Gore', 'write']]);
	});

	it('gives each warning its own limits back on an undone merge, leaving nothing behind', async () => {
		await saveUniverse({ 'warning:blood': 'avoid' });
		await saveStory({ 'warning:gore': 'write' });
		const before = await allPreferences();
		expect(await mergeTag(db, 'warning', await tagId('blood'), 'Gore')).toEqual({ ok: true });
		expect(await unmergeTag(db, 'warning', await tagId('blood'))).toBe(true);
		expect(await allPreferences()).toEqual(before);
		expect(await limits()).toEqual([
			['Blood', 'avoid'],
			['Gore', 'write']
		]);
	});

	it('applies a save that lands just after a merge, through the fold', async () => {
		// The form was read before the merge, so it posted Blood as live.
		expect(await mergeTag(db, 'warning', await tagId('blood'), 'Gore')).toEqual({ ok: true });
		await savePreferences(
			db,
			user.id,
			{ storyId },
			{ changes: { 'warning:blood': 'avoid' }, notes: undefined }
		);
		expect(await limits()).toEqual([['Gore', 'avoid']]);
	});

	it('follows a chain of merges, and drops the chain with a removed survivor', async () => {
		await db.insert(tags).values({ kind: 'warning', name: 'Violence', slug: 'violence' });
		// A chain two steps deep, as older data could hold.
		await db
			.update(tags)
			.set({ mergedIntoId: await tagId('gore') })
			.where(eq(tags.id, await tagId('blood')));
		await db
			.update(tags)
			.set({ mergedIntoId: await tagId('violence') })
			.where(eq(tags.id, await tagId('gore')));
		await db
			.update(stories)
			.set({ assistantPreferences: { 'warning:blood': 'avoid', 'warning:violence': 'write' } })
			.where(eq(stories.id, storyId));
		expect(await limits()).toEqual([['Violence', 'avoid']]);
		await setTagRemoved(db, 'warning', await tagId('violence'), true, user.id);
		expect(await limits()).toEqual([]);
	});

	it('keeps the limit and the review run key through a rename', async () => {
		await saveStory({ 'warning:gore': 'avoid' });
		const runKey = async () =>
			reviewSettingsKey(
				NO_LANGUAGE,
				null,
				false,
				null,
				await storyAssistantPreferences(db, storyId)
			);
		const before = await runKey();
		expect(await renameTag(db, 'warning', await tagId('gore'), 'Graphic gore')).toEqual({
			ok: true
		});
		expect(await limits()).toEqual([['Graphic gore', 'avoid']]);
		expect(await runKey()).toBe(before);
	});

	it("drops a removed warning's limit, and a restore brings it back", async () => {
		await saveStory({ 'warning:gore': 'avoid' });
		await saveUniverse({ 'warning:blood': 'write' });
		await setTagRemoved(db, 'warning', await tagId('gore'), true, user.id);
		expect(await limits()).toEqual([['Blood', 'write']]);
		await setTagRemoved(db, 'warning', await tagId('gore'), false, user.id);
		expect(await limits()).toEqual([
			['Blood', 'write'],
			['Gore', 'avoid']
		]);
		// One merged away and then removed still counts toward its survivor,
		// which its stories keep showing.
		expect(await mergeTag(db, 'warning', await tagId('blood'), 'Gore')).toEqual({ ok: true });
		await saveStory({ 'warning:gore': '' });
		await setTagRemoved(db, 'warning', await tagId('blood'), true, user.id);
		expect(await limits()).toEqual([['Gore', 'write']]);
	});
});
