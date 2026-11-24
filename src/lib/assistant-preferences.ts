// The writer's Assistant preferences for a story or a universe: a house style
// (each choice from a fixed list) and which of the review's habit checks to
// run or leave alone. Stored as one small JSON object of these known keys on
// the story and on the universe (a story's own value wins, key by key), with
// one short markdown field beside it for habits no list can know. A key that
// is absent is "Not set", which keeps the Assistant's default: it infers the
// house style from the prose, and it checks every habit.

export const HOUSE_STYLE = [
	{
		key: 'quoteMarks',
		label: 'Quote marks',
		options: [
			{ value: 'double', label: 'Double ("...")' },
			{ value: 'single', label: "Single ('...')" }
		]
	},
	{
		key: 'serialComma',
		label: 'Serial comma',
		options: [
			{ value: 'yes', label: 'Yes (red, white, and blue)' },
			{ value: 'no', label: 'No (red, white and blue)' }
		]
	},
	{
		key: 'thoughts',
		label: 'Thoughts',
		options: [
			{ value: 'italics', label: 'In italics' },
			{ value: 'plain', label: 'Plain text' }
		]
	},
	{
		key: 'tense',
		label: 'Tense',
		options: [
			{ value: 'past', label: 'Past' },
			{ value: 'present', label: 'Present' }
		]
	},
	{
		key: 'narration',
		label: 'Narration',
		options: [
			{ value: 'first', label: 'First person' },
			{ value: 'third-limited', label: 'Third person, limited' },
			{ value: 'third-omniscient', label: 'Third person, omniscient' },
			{ value: 'other', label: 'Other' }
		]
	}
] as const;

// The habits review and the pattern pass look for, each one a switch.
export const HABIT_CHECKS = [
	{ key: 'filterVerbs', label: 'Filter verbs (saw, heard, felt)' },
	{ key: 'epithets', label: 'Point-of-view epithets (the elf, the old man)' },
	{ key: 'danglingModifiers', label: 'Dangling modifiers (running late, the bus left)' },
	{ key: 'repetition', label: 'Close repetition' },
	{ key: 'commaSplices', label: 'Comma splices (it rained, we stayed in)' },
	{ key: 'petPhrases', label: 'Pet words and phrases' },
	{ key: 'sentenceShapes', label: 'Repeated sentence shapes and gestures' }
] as const;

export type HouseStyleKey = (typeof HOUSE_STYLE)[number]['key'];
export type HouseStyleValue<K extends HouseStyleKey> = Extract<
	(typeof HOUSE_STYLE)[number],
	{ key: K }
>['options'][number]['value'];
export type HabitCheck = (typeof HABIT_CHECKS)[number]['key'];
export type CheckChoice = 'check' | 'leave';

// What is stored on a story or a universe: only the keys that are set.
export type StoredPreferences = { [K in HouseStyleKey]?: HouseStyleValue<K> } & {
	[K in HabitCheck]?: CheckChoice;
};

// What the prompts are given: every house-style key (null when not set), the
// habits to leave alone, and the writer's own notes.
export type PreferenceSetting = {
	houseStyle: { [K in HouseStyleKey]: HouseStyleValue<K> | null };
	leaveAlone: HabitCheck[];
	notes: string | null;
};

export const NO_PREFERENCES: PreferenceSetting = {
	houseStyle: { quoteMarks: null, serialComma: null, thoughts: null, tense: null, narration: null },
	leaveAlone: [],
	notes: null
};

// The blank choice of a story setting that follows its universe's, for the
// preference and language selects alike. Standalone stories share a hidden
// universe the writer knows as the settings for standalone stories.
export function inheritedChoiceLabel(standalone: boolean): string {
	return standalone ? 'Use the standalone default' : "Use the universe's";
}

// The cap on the free-text field, in characters.
export const MAX_ASSISTANT_NOTES = 1000;

const CHECK_CHOICES: readonly string[] = ['check', 'leave'];

function houseStyleValue(key: HouseStyleKey, value: unknown): string | null {
	const field = HOUSE_STYLE.find((item) => item.key === key)!;
	return field.options.some((option) => option.value === value) ? (value as string) : null;
}

// A stored or submitted object as the known keys with valid values; anything
// else (an unknown key, a value since dropped from a list, not an object at
// all) reads as not set.
export function normalisePreferences(raw: unknown): StoredPreferences {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const source = raw as Record<string, unknown>;
	const out: Record<string, string> = {};
	for (const { key } of HOUSE_STYLE) {
		const value = houseStyleValue(key, source[key]);
		if (value) out[key] = value;
	}
	for (const { key } of HABIT_CHECKS) {
		if (CHECK_CHOICES.includes(source[key] as string)) out[key] = source[key] as string;
	}
	return out as StoredPreferences;
}

// The lines the prompts put around the notes. Kept here so the notes can
// never hold one and end the framing early.
export const NOTES_BEGIN = "--- the writer's notes ---";
export const NOTES_END = '--- end of the notes ---';

// A line compared with the framing lines: case and runs of whitespace ignored,
// so "--- THE  writer's notes ---" cannot pass as text and close the fence.
const markerKey = (line: string) => line.trim().replace(/\s+/g, ' ').toLowerCase();
const MARKER_KEYS = new Set([markerKey(NOTES_BEGIN), markerKey(NOTES_END)]);

// The free text, trimmed, with Windows line ends (a submitted form sends
// CRLF) as plain newlines, null characters dropped, and any line that reads
// as one of the framing lines removed; blank is not set.
export function normaliseNotes(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const text = raw
		.replace(/\r\n?/g, '\n')
		.replaceAll('\u0000', '')
		.split('\n')
		.filter((line) => !MARKER_KEYS.has(markerKey(line)))
		.join('\n')
		.trim();
	return text || null;
}

// The preferences a story works under: each key the story's own, else the
// universe's, else not set; the story's notes, else the universe's.
export function effectivePreferences(
	story: { preferences: unknown; notes: string | null | undefined } | null,
	universe: { preferences: unknown; notes: string | null | undefined } | null
): PreferenceSetting {
	const own = normalisePreferences(story?.preferences);
	const inherited = normalisePreferences(universe?.preferences);
	const merged: StoredPreferences = { ...inherited, ...own };
	const houseStyle = { ...NO_PREFERENCES.houseStyle };
	for (const { key } of HOUSE_STYLE) {
		(houseStyle as Record<string, string | null>)[key] = merged[key] ?? null;
	}
	return {
		houseStyle,
		leaveAlone: HABIT_CHECKS.filter(({ key }) => merged[key] === 'leave').map(({ key }) => key),
		notes: normaliseNotes(story?.notes) ?? normaliseNotes(universe?.notes)
	};
}

export type PreferencesForm =
	| { ok: true; preferences: StoredPreferences; notes: string | null }
	| { ok: false; reason: string; submitted: SubmittedPreferences };

// The form's values as submitted, handed back on a refusal so the page shows
// them again instead of losing what was typed.
export type SubmittedPreferences = Record<string, string>;

const FIELD_KEYS = [
	...HOUSE_STYLE.map((item) => item.key),
	...HABIT_CHECKS.map((item) => item.key),
	'assistantNotes'
];

// The preferences form as submitted: one select per key (blank is not set)
// and the notes. A value that is not on its list is refused rather than
// dropped, so a tampered form does not silently clear a setting.
export function readPreferencesForm(data: FormData): PreferencesForm {
	const submitted: SubmittedPreferences = {};
	for (const key of FIELD_KEYS) {
		const raw = data.get(key);
		submitted[key] = typeof raw === 'string' ? raw : '';
	}
	const refuse = (reason: string): PreferencesForm => ({ ok: false, reason, submitted });
	const out: Record<string, string> = {};
	for (const { key } of HOUSE_STYLE) {
		const raw = submitted[key].trim();
		if (!raw) continue;
		if (!houseStyleValue(key, raw)) return refuse('Pick each setting from its list.');
		out[key] = raw;
	}
	for (const { key } of HABIT_CHECKS) {
		const raw = submitted[key].trim();
		if (!raw) continue;
		if (!CHECK_CHOICES.includes(raw)) return refuse('Pick each setting from its list.');
		out[key] = raw;
	}
	const notes = normaliseNotes(submitted.assistantNotes);
	if (notes && notes.length > MAX_ASSISTANT_NOTES) {
		return refuse(`Keep your notes to ${MAX_ASSISTANT_NOTES} characters or fewer.`);
	}
	return { ok: true, preferences: out as StoredPreferences, notes };
}
