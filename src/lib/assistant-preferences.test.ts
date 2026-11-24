import { describe, expect, it } from 'vitest';
import {
	effectivePreferences,
	HABIT_CHECKS,
	HOUSE_STYLE,
	MAX_ASSISTANT_NOTES,
	NO_PREFERENCES,
	normaliseNotes,
	normalisePreferences,
	readPreferencesForm
} from './assistant-preferences.ts';

function form(fields: Record<string, string>): FormData {
	const data = new FormData();
	for (const [key, value] of Object.entries(fields)) data.set(key, value);
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

	it('reads the form, blank as not set', () => {
		expect(
			readPreferencesForm(
				form({ quoteMarks: 'double', serialComma: '', petPhrases: 'leave', assistantNotes: ' n ' })
			)
		).toEqual({
			ok: true,
			preferences: { quoteMarks: 'double', petPhrases: 'leave' },
			notes: 'n'
		});
		expect(readPreferencesForm(form({}))).toEqual({ ok: true, preferences: {}, notes: null });
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
