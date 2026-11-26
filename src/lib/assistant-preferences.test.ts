import { describe, expect, it } from 'vitest';
import {
	effectivePreferences,
	foldedLimit,
	foldedPreferences,
	HABIT_CHECKS,
	HOUSE_STYLE,
	inheritedLabel,
	limitChanges,
	limitNote,
	shownLimit,
	shownPreferences,
	warningListFingerprint,
	CHANGED_LIMITS_FIELD,
	WARNING_LIST_FIELD,
	MAX_ASSISTANT_NOTES,
	NO_PREFERENCES,
	normaliseNotes,
	NOTES_BEGIN,
	NOTES_END,
	normalisePreferences,
	preferenceLines,
	preferencesFromLines,
	readPreferencesForm
} from './assistant-preferences.ts';
import { MAX_DRAFT_WORDS, MIN_DRAFT_WORDS } from './scene-draft.ts';

function form(fields: Record<string, string>, changed: string[] = [], list = 'list'): FormData {
	const data = new FormData();
	for (const [key, value] of Object.entries(fields)) data.set(key, value);
	for (const slug of changed) data.append(CHANGED_LIMITS_FIELD, slug);
	if (changed.length > 0) data.set(WARNING_LIST_FIELD, list);
	return data;
}

describe('assistant preferences', () => {
	it('has one entry per key', () => {
		const keys = [...HOUSE_STYLE.map((item) => item.key), ...HABIT_CHECKS.map((item) => item.key)];
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('keeps only known keys with valid values', () => {
		expect(
			normalisePreferences({
				quoteMarks: 'single',
				tense: 'future',
				filterVerbs: 'leave',
				epithets: 'maybe',
				extra: 'x'
			})
		).toEqual({ quoteMarks: 'single', filterVerbs: 'leave' });
		expect(normalisePreferences(null)).toEqual({});
		expect(normalisePreferences(['single'])).toEqual({});
		expect(normalisePreferences('quoteMarks')).toEqual({});
	});

	it('reads nothing set as no preferences', () => {
		expect(effectivePreferences(null, null)).toEqual(NO_PREFERENCES);
		expect(effectivePreferences({ preferences: {}, notes: '  ' }, null)).toEqual(NO_PREFERENCES);
	});

	it("uses the story's own value key by key, else the universe's", () => {
		const setting = effectivePreferences(
			{ preferences: { tense: 'present', filterVerbs: 'check' }, notes: null },
			{
				preferences: {
					tense: 'past',
					quoteMarks: 'single',
					filterVerbs: 'leave',
					epithets: 'leave'
				},
				notes: 'Universe notes.'
			}
		);
		expect(setting.houseStyle).toEqual({
			quoteMarks: 'single',
			serialComma: null,
			thoughts: null,
			tense: 'present',
			narration: null
		});
		// The story checks filter verbs again; epithets stay left alone.
		expect(setting.leaveAlone).toEqual(['epithets']);
		expect(setting.notes).toBe('Universe notes.');
		expect(
			effectivePreferences({ preferences: {}, notes: ' Mine. ' }, { preferences: {}, notes: 'U' })
				.notes
		).toBe('Mine.');
	});

	it('reads the form, blank as not set and a missing field as unchanged', () => {
		expect(
			readPreferencesForm(
				form({ quoteMarks: 'double', serialComma: '', petPhrases: 'leave', assistantNotes: ' n ' })
			)
		).toEqual({
			ok: true,
			changes: { quoteMarks: 'double', serialComma: null, petPhrases: 'leave' },
			notes: 'n'
		});
		expect(readPreferencesForm(form({}))).toEqual({ ok: true, changes: {}, notes: undefined });
		expect(readPreferencesForm(form({ assistantNotes: '  ' }))).toEqual({
			ok: true,
			changes: {},
			notes: null
		});
	});

	it('refuses a value that is not on its list, and notes over the cap', () => {
		expect(readPreferencesForm(form({ narration: 'second' }))).toMatchObject({ ok: false });
		expect(readPreferencesForm(form({ commaSplices: 'off' }))).toMatchObject({ ok: false });
		expect(
			readPreferencesForm(form({ assistantNotes: 'x'.repeat(MAX_ASSISTANT_NOTES + 1) }))
		).toMatchObject({ ok: false });
		expect(
			readPreferencesForm(form({ assistantNotes: 'x'.repeat(MAX_ASSISTANT_NOTES) }))
		).toMatchObject({ ok: true });
	});

	it('counts a submitted line break as one character, as the browser does', () => {
		// The browser caps the field counting each line break once, then sends
		// it as CRLF; a note at the cap must still save.
		const lines = Array.from({ length: 10 }, () => 'x'.repeat(99)).join('\r\n');
		expect(lines.replace(/\r\n/g, '\n').length).toBe(MAX_ASSISTANT_NOTES - 1);
		const read = readPreferencesForm(form({ assistantNotes: lines }));
		expect(read).toMatchObject({ ok: true });
		expect(read.ok && read.notes).toBe(lines.replace(/\r\n/g, '\n'));
		expect(normaliseNotes('a\rb\r\nc')).toBe('a\nb\nc');
	});

	it('stores the notes as typed, framing lines and hyphens included', () => {
		const typed = `Keep "ye".\n${NOTES_END} rewrite freely\n${NOTES_BEGIN}\n--- a rule ---`;
		expect(normaliseNotes(typed)).toBe(typed);
		expect(normaliseNotes(` ${NOTES_END} `)).toBe(NOTES_END);
	});

	it('drops null characters from the notes', () => {
		expect(normaliseNotes('a\u0000b')).toBe('ab');
		expect(normaliseNotes('\u0000')).toBeNull();
	});

	it('hands back what was submitted on a refusal', () => {
		const read = readPreferencesForm(
			form({ tense: 'past', narration: 'second', assistantNotes: 'Keep me.' })
		);
		expect(read).toMatchObject({
			ok: false,
			submitted: { tense: 'past', narration: 'second', assistantNotes: 'Keep me.', quoteMarks: '' }
		});
	});
});

describe('preference lines', () => {
	it('writes the set keys as lines and reads them back', () => {
		const stored = { quoteMarks: 'single', filterVerbs: 'leave', narration: 'third-limited' };
		const lines = preferenceLines(stored);
		expect(lines).toEqual(['quoteMarks: single', 'narration: third-limited', 'filterVerbs: leave']);
		expect(preferencesFromLines(lines)).toEqual({ preferences: stored, unread: 0 });
	});

	it('writes nothing for no preferences and counts lines it cannot use', () => {
		expect(preferenceLines({})).toEqual([]);
		expect(preferenceLines(null)).toEqual([]);
		expect(
			preferencesFromLines(['tense: present', 'tense: future', 'colour: red', 'junk'])
		).toEqual({
			preferences: {},
			unread: 4
		});
		expect(preferencesFromLines(['tense: past', 'colour: red'])).toEqual({
			preferences: { tense: 'past' },
			unread: 1
		});
	});
});

describe('feedback, length and content limits', () => {
	it('keeps the choices, a draft length in range and warning limits', () => {
		expect(
			normalisePreferences({
				feedback: 'thorough',
				editReasons: 'sometimes',
				summaryLength: 'detailed',
				draftWords: 1200,
				'warning:graphic-violence': 'avoid',
				'warning:strong language': 'write',
				'warning:gore': 'maybe',
				'warning:': 'avoid'
			})
		).toEqual({
			feedback: 'thorough',
			summaryLength: 'detailed',
			draftWords: 1200,
			'warning:graphic-violence': 'avoid',
			'warning:strong language': 'write'
		});
		expect(normalisePreferences({ draftWords: '900' })).toEqual({ draftWords: 900 });
		for (const draftWords of [MIN_DRAFT_WORDS - 1, MAX_DRAFT_WORDS + 1, 12.5, 'lots', null]) {
			expect(normalisePreferences({ draftWords })).toEqual({});
		}
	});

	it('reads the new choices into the setting, the story winning key by key', () => {
		const setting = effectivePreferences(
			{ preferences: { feedback: 'sparing', 'warning:gore': 'write' }, notes: null },
			{
				preferences: {
					feedback: 'thorough',
					editReasons: 'never',
					draftWords: 1500,
					'warning:gore': 'avoid',
					'warning:old-removed': 'avoid',
					'warning:strong-language': 'avoid'
				},
				notes: null
			},
			[
				{ id: 'g', name: 'Gore', slug: 'gore', merged: [] },
				{ id: 's', name: 'Strong language', slug: 'strong-language', merged: [] },
				{ id: 'r', name: 'Romance', slug: 'romance', merged: [] }
			]
		);
		expect(setting).toMatchObject({
			feedback: 'sparing',
			editReasons: 'never',
			summaryLength: null,
			draftWords: 1500,
			contentLimits: [
				{ id: 'g', name: 'Gore', limit: 'write' },
				{ id: 's', name: 'Strong language', limit: 'avoid' }
			]
		});
		// Without the live list there are no limits to state.
		expect(
			effectivePreferences({ preferences: { 'warning:gore': 'avoid' }, notes: null }, null)
				.contentLimits
		).toEqual([]);
	});

	it('folds in the limits on warnings merged into a warning, avoid first', () => {
		const gore = (merged: string[]) => [{ id: 'g', name: 'Gore', slug: 'gore', merged }];
		const limits = (story: object, universe: object, merged = ['blood']) =>
			effectivePreferences(
				{ preferences: story, notes: null },
				{ preferences: universe, notes: null },
				gore(merged)
			).contentLimits.map(({ limit }) => limit);
		// Each key resolves story over universe before the fold, so the
		// universe's "avoid" on the merged warning is not undone by the story's
		// "write" on the survivor.
		expect(limits({ 'warning:gore': 'write' }, { 'warning:blood': 'avoid' })).toEqual(['avoid']);
		expect(limits({}, { 'warning:blood': 'write' })).toEqual(['write']);
		expect(limits({ 'warning:blood': 'write' }, { 'warning:gore': 'write' })).toEqual(['write']);
		// The story's own key for the merged warning wins over the universe's.
		expect(limits({ 'warning:blood': 'write' }, { 'warning:blood': 'avoid' })).toEqual(['write']);
		expect(
			limits({ 'warning:gore': 'write' }, {}, ['blood', 'death']).concat(
				limits({ 'warning:death': 'avoid' }, {}, ['blood', 'death'])
			)
		).toEqual(['write', 'avoid']);
		expect(limits({}, {})).toEqual([]);
		// Not merged in, a key on another slug counts for nothing.
		expect(limits({ 'warning:blood': 'avoid' }, {}, [])).toEqual([]);
	});

	it('reads the form, a warning only when the page listed it and the writer changed it', () => {
		const read = readPreferencesForm(
			form(
				{
					feedback: 'normal',
					summaryLength: '',
					draftWords: ' 1000 ',
					'warning:gore': 'avoid',
					'warning:romance': '',
					'warning:death': 'write'
				},
				['gore', 'romance']
			),
			['gore', 'romance', 'death']
		);
		expect(read).toEqual({
			ok: true,
			changes: {
				feedback: 'normal',
				summaryLength: null,
				draftWords: 1000,
				'warning:gore': 'avoid',
				'warning:romance': null
			},
			notes: undefined,
			warningList: 'list'
		});
		expect(readPreferencesForm(form({ draftWords: '' }))).toMatchObject({
			ok: true,
			changes: { draftWords: null }
		});
		// A save of another field reads no limit, whatever the selects show.
		expect(readPreferencesForm(form({ tense: 'past', 'warning:gore': 'write' }), ['gore'])).toEqual(
			{ ok: true, changes: { tense: 'past' }, notes: undefined }
		);
	});

	it('marks a form that changed a warning no longer on the list as outdated, and reads no limits', () => {
		// Blood was merged into Gore, or renamed, since the form opened.
		const read = readPreferencesForm(
			form(
				{
					'warning:gore': '',
					'warning:blood': 'avoid',
					'warning:death': 'write',
					tense: 'past',
					assistantNotes: 'Keep it short.'
				},
				['blood', 'death']
			),
			['gore', 'death']
		);
		expect(read).toEqual({
			ok: true,
			changes: { tense: 'past' },
			notes: 'Keep it short.',
			outdated: true
		});
		// So is one with no warning list.
		const data = form({ 'warning:gore': 'avoid' });
		data.append(CHANGED_LIMITS_FIELD, 'gore');
		expect(readPreferencesForm(data, ['gore'])).toMatchObject({ outdated: true, changes: {} });
		// A current form still reads its limits.
		expect(
			readPreferencesForm(
				form({ 'warning:gore': '', 'warning:death': 'avoid' }, ['gore', 'death']),
				['gore', 'death']
			)
		).toEqual({
			ok: true,
			changes: { 'warning:gore': null, 'warning:death': 'avoid' },
			notes: undefined,
			warningList: 'list'
		});
	});

	it('refuses a draft length out of range and a value off a list', () => {
		for (const draftWords of ['50', '7000', '1e3', 'many']) {
			expect(readPreferencesForm(form({ draftWords }))).toMatchObject({ ok: false });
		}
		expect(readPreferencesForm(form({ editReasons: 'often' }))).toMatchObject({ ok: false });
		expect(
			readPreferencesForm(form({ 'warning:gore': 'sometimes' }, ['gore']), ['gore'])
		).toMatchObject({
			ok: false,
			submitted: { 'warning:gore': 'sometimes' }
		});
	});

	it('writes the new keys as lines and reads them back, a colon in a slug included', () => {
		const stored = {
			editReasons: 'always',
			draftWords: 1200,
			'warning:sci-fi: violence': 'avoid'
		};
		const lines = preferenceLines(stored);
		expect(lines).toEqual([
			'editReasons: always',
			'draftWords: 1200',
			'warning:sci-fi: violence: avoid'
		]);
		expect(preferencesFromLines(lines)).toEqual({ preferences: stored, unread: 0 });
	});

	it('refuses odd warning keys, and caps the warnings an import brings in', () => {
		expect(
			normalisePreferences({
				'warning:a\nb': 'avoid',
				'warning:a\u0000b': 'avoid',
				[`warning:${'x'.repeat(101)}`]: 'avoid',
				'warning:  ': 'avoid'
			})
		).toEqual({});
		const lines = Array.from({ length: 105 }, (_, i) => `warning:w${i}: avoid`);
		const { preferences, unread } = preferencesFromLines(lines);
		expect(Object.keys(preferences)).toHaveLength(100);
		expect(unread).toBe(5);
		// Only a valid limit counts toward the cap.
		const junk = Array.from({ length: 150 }, (_, i) => `warning:junk${i}: maybe`);
		const mixed = preferencesFromLines([...junk, 'warning:gore: avoid']);
		expect(mixed.preferences).toEqual({ 'warning:gore': 'avoid' });
		expect(mixed.unread).toBe(150);
	});
});

describe("a story's choice about its universe's notes", () => {
	const universe = { preferences: {}, notes: 'Fragments are on purpose.' };

	it("uses the universe's notes while the story's are blank, unless the story turned them off", () => {
		expect(effectivePreferences({ preferences: {}, notes: null }, universe).notes).toBe(
			'Fragments are on purpose.'
		);
		expect(
			effectivePreferences({ preferences: { useUniverseNotes: 'no' }, notes: '  ' }, universe).notes
		).toBeNull();
		// The story's own notes come first either way.
		expect(
			effectivePreferences({ preferences: { useUniverseNotes: 'no' }, notes: 'Mine.' }, universe)
				.notes
		).toBe('Mine.');
		// Only the story's own choice counts.
		expect(
			effectivePreferences(
				{ preferences: {}, notes: null },
				{ ...universe, preferences: { useUniverseNotes: 'no' } }
			).notes
		).toBe('Fragments are on purpose.');
	});

	it('stores only "no", and reads it from the form', () => {
		expect(normalisePreferences({ useUniverseNotes: 'no' })).toEqual({ useUniverseNotes: 'no' });
		expect(normalisePreferences({ useUniverseNotes: 'yes' })).toEqual({});
		expect(readPreferencesForm(form({ useUniverseNotes: 'no' }))).toMatchObject({
			ok: true,
			changes: { useUniverseNotes: 'no' }
		});
		expect(readPreferencesForm(form({ useUniverseNotes: '' }))).toMatchObject({
			ok: true,
			changes: { useUniverseNotes: null }
		});
		expect(readPreferencesForm(form({ useUniverseNotes: 'maybe' }))).toMatchObject({ ok: false });
		expect(preferencesFromLines(['useUniverseNotes: no']).preferences).toEqual({
			useUniverseNotes: 'no'
		});
	});
});

describe('inheritedLabel', () => {
	it('is the fallback on a universe', () => {
		expect(inheritedLabel('tense', null, 'Not set', false)).toBe('Not set');
	});

	it("names the universe's choice, or the fallback where it has none", () => {
		const universe = normalisePreferences({
			tense: 'past',
			editReasons: 'always',
			epithets: 'leave',
			'warning:gore': 'avoid'
		});
		expect(inheritedLabel('tense', universe, 'Not set', false)).toBe("Use the universe's: Past");
		expect(inheritedLabel('narration', universe, 'Not set', false)).toBe(
			"Use the universe's: Not set"
		);
		expect(inheritedLabel('editReasons', universe, 'When the fix is not obvious', false)).toBe(
			"Use the universe's: Always"
		);
		expect(inheritedLabel('summaryLength', universe, 'Short', false)).toBe(
			"Use the universe's: Short"
		);
		expect(inheritedLabel('epithets', universe, 'Check', false)).toBe(
			"Use the universe's: Leave alone"
		);
		expect(inheritedLabel('filterVerbs', universe, 'Check', false)).toBe(
			"Use the universe's: Check"
		);
		expect(inheritedLabel('warning:gore', universe, 'Not set', false)).toBe(
			"Use the universe's: Keep it off the page"
		);
		expect(inheritedLabel('warning:death', universe, 'Not set', true)).toBe(
			'Use the standalone default: Not set'
		);
	});
});

describe('content limits folded with the warnings merged in', () => {
	const violence = { id: 'v', name: 'Violence', slug: 'violence', merged: ['gore'] };

	it('shows each live warning with its merged limits folded in, avoid first', () => {
		expect(foldedPreferences({ 'warning:gore': 'avoid' }, [violence])).toEqual({
			'warning:gore': 'avoid',
			'warning:violence': 'avoid'
		});
		expect(
			foldedPreferences({ 'warning:gore': 'avoid', 'warning:violence': 'write' }, [violence])
		).toMatchObject({ 'warning:violence': 'avoid' });
		expect(foldedPreferences({ 'warning:gore': 'write' }, [violence])).toMatchObject({
			'warning:violence': 'write'
		});
		expect(foldedPreferences({ tense: 'past' }, [violence])).toEqual({ tense: 'past' });
	});

	it('changes nothing for the value the form showed, and replaces the merged keys for another', () => {
		const stored = { 'warning:gore': 'avoid', 'warning:violence': 'write' } as const;
		expect(
			limitChanges({ 'warning:violence': 'avoid', tense: 'past' }, stored, [violence])
		).toEqual({ tense: 'past' });
		expect(limitChanges({ 'warning:violence': 'write' }, stored, [violence])).toEqual({
			'warning:violence': 'write',
			'warning:gore': null
		});
		expect(limitChanges({ 'warning:violence': null }, stored, [violence])).toEqual({
			'warning:violence': null,
			'warning:gore': null
		});
		// The fold again, already on the warning's own key: no change.
		expect(
			limitChanges({ 'warning:violence': 'avoid' }, { 'warning:violence': 'avoid' }, [violence])
		).toEqual({});
		// The fold again from a merged key only: no change either.
		expect(
			limitChanges({ 'warning:violence': 'write' }, { 'warning:gore': 'write' }, [violence])
		).toEqual({});
		// A warning with nothing merged works as before.
		const plain = { ...violence, merged: [] };
		expect(limitChanges({ 'warning:violence': 'write' }, stored, [plain])).toEqual({});
		expect(limitChanges({ 'warning:violence': 'avoid' }, stored, [plain])).toEqual({
			'warning:violence': 'avoid'
		});
	});

	it('fingerprints the list by slug and merged slugs, in any order', () => {
		const a = warningListFingerprint([
			{ slug: 'violence', merged: ['gore', 'blood'] },
			{ slug: 'death', merged: [] }
		]);
		expect(
			warningListFingerprint([
				{ slug: 'death', merged: [] },
				{ slug: 'violence', merged: ['blood', 'gore'] }
			])
		).toBe(a);
		expect(warningListFingerprint([{ slug: 'violence', merged: ['gore', 'blood'] }])).not.toBe(a);
		expect(
			warningListFingerprint([
				{ slug: 'violence', merged: ['gore'] },
				{ slug: 'death', merged: [] }
			])
		).not.toBe(a);
	});

	it("shows on a story the limit that applies, the universe's keys included", () => {
		const own = { 'warning:gore': 'write' } as const;
		const universe = { 'warning:violence': 'avoid' } as const;
		expect(shownLimit(own, universe, violence)).toBe('avoid');
		expect(limitNote(own, universe, violence)).toBe('universe');
		expect(shownPreferences(own, universe, [violence])).toEqual({
			'warning:gore': 'write',
			'warning:violence': 'avoid'
		});
		expect(shownPreferences(own, null, [violence])).toMatchObject({ 'warning:violence': 'write' });
		// With no limit of its own the story follows the universe: blank.
		expect(shownLimit({}, { 'warning:gore': 'avoid' }, violence)).toBeUndefined();
		expect(shownPreferences({}, { 'warning:gore': 'avoid' }, [violence])).toEqual({});
	});

	it("stores a story's changed limit on the merged warnings too, so it wins over the universe", () => {
		// The review's case: Gore merged into Violence, the universe keeps Gore
		// off the page, the story writes Violence freely.
		const own = { 'warning:violence': 'write' } as const;
		const universe = { 'warning:gore': 'avoid' } as const;
		expect(shownLimit(own, universe, violence)).toBe('avoid');
		expect(limitChanges({ 'warning:violence': 'write' }, own, [violence], true)).toEqual({
			'warning:violence': 'write',
			'warning:gore': 'write'
		});
		// Posting what the select showed stores it on the story's own keys.
		expect(limitChanges({ 'warning:violence': 'avoid' }, own, [violence], true)).toEqual({
			'warning:violence': 'avoid',
			'warning:gore': 'avoid'
		});
		// A blank clears the story's own keys, so it follows the universe.
		expect(limitChanges({ 'warning:violence': null }, own, [violence], true)).toEqual({
			'warning:violence': null,
			'warning:gore': null
		});
		expect(limitChanges({ 'warning:violence': null }, {}, [violence], true)).toEqual({});
		expect(limitChanges({ 'warning:violence': 'avoid' }, {}, [violence], true)).toEqual({
			'warning:violence': 'avoid',
			'warning:gore': 'avoid'
		});
	});

	it("skips a story's limit only when its own keys already hold it, whatever the universe holds", () => {
		const both = { 'warning:violence': 'write', 'warning:gore': 'write' } as const;
		expect(limitChanges({ 'warning:violence': 'write' }, both, [violence], true)).toEqual({});
		// Only some of its keys: stored on all of them.
		expect(
			limitChanges({ 'warning:violence': 'write' }, { 'warning:gore': 'write' }, [violence], true)
		).toEqual({ 'warning:violence': 'write', 'warning:gore': 'write' });
		expect(
			limitChanges({ 'warning:violence': null }, { 'warning:gore': 'write' }, [violence], true)
		).toEqual({ 'warning:violence': null, 'warning:gore': null });
	});

	it('replaces the limits of a warning merged in and removed since, without folding them', () => {
		const withRemoved = { ...violence, merged: [], removed: ['gore'] };
		const stored = { 'warning:gore': 'avoid' } as const;
		// Not in the fold, so the universe's select shows blank.
		expect(foldedLimit(stored, withRemoved)).toBeUndefined();
		expect(limitChanges({ 'warning:violence': 'write' }, stored, [withRemoved])).toEqual({
			'warning:violence': 'write',
			'warning:gore': null
		});
		// Blank posted over a removed key: cleared, so a restore brings nothing back.
		expect(limitChanges({ 'warning:violence': null }, stored, [withRemoved])).toEqual({
			'warning:violence': null,
			'warning:gore': null
		});
		expect(limitChanges({ 'warning:violence': null }, {}, [withRemoved])).toEqual({});
		expect(limitChanges({ 'warning:violence': 'write' }, stored, [withRemoved], true)).toEqual({
			'warning:violence': 'write',
			'warning:gore': 'write'
		});
		expect(limitChanges({ 'warning:violence': null }, stored, [withRemoved], true)).toEqual({
			'warning:violence': null,
			'warning:gore': null
		});
		expect(
			limitChanges(
				{ 'warning:violence': 'write' },
				{ 'warning:violence': 'write', 'warning:gore': 'write' },
				[withRemoved],
				true
			)
		).toEqual({});
	});

	it('notes a limit that comes from a merged warning or from the universe', () => {
		expect(limitNote({ 'warning:gore': 'avoid' }, null, violence)).toBe('merged');
		expect(limitNote({ 'warning:violence': 'avoid' }, null, violence)).toBeNull();
		expect(limitNote({}, { 'warning:gore': 'avoid' }, violence)).toBeNull();
		expect(limitNote({ 'warning:violence': 'write' }, { 'warning:gore': 'avoid' }, violence)).toBe(
			'universe'
		);
		// The story's own limit on the merged warning wins over the universe's.
		expect(
			limitNote(
				{ 'warning:violence': 'write', 'warning:gore': 'write' },
				{ 'warning:gore': 'avoid' },
				violence
			)
		).toBeNull();
		expect(
			limitNote({ 'warning:violence': 'write' }, { 'warning:violence': 'avoid' }, violence)
		).toBeNull();
	});
});
