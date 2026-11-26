// The writer's Assistant preferences for a story or a universe: a house style
// (each choice from a fixed list), which of the review's habit checks to run
// or leave alone, how the Assistant gives feedback and how long it writes, and
// a limit per content warning on the admin's list. Stored as one small JSON
// object of these known keys on the story and on the universe (a story's own
// value wins, key by key), with one short markdown field beside it for habits
// no list can know. A key that is absent is "Not set", which keeps the
// Assistant's default: it infers the house style from the prose, checks every
// habit, and works as it did before the choice existed.

import { MAX_DRAFT_WORDS, MIN_DRAFT_WORDS } from './scene-draft.ts';

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

// How the Assistant gives feedback and how long it writes. Each blank choice
// keeps today's behaviour, which unset names.
export const ASSISTANT_CHOICES = [
	{
		key: 'feedback',
		label: 'How much a review points out',
		unset: 'Not set',
		options: [
			{ value: 'sparing', label: 'Only the most important notes' },
			{ value: 'normal', label: 'A balanced set of notes' },
			{ value: 'thorough', label: 'Everything worth a look' }
		]
	},
	{
		key: 'editReasons',
		label: 'Reasons on suggested edits',
		unset: 'When the fix is not obvious',
		options: [
			{ value: 'always', label: 'Always' },
			{ value: 'unobvious', label: 'When the fix is not obvious' },
			{ value: 'never', label: 'Never' }
		]
	},
	{
		key: 'summaryLength',
		label: 'Summaries, arcs and recaps',
		unset: 'Short',
		options: [
			{ value: 'short', label: 'Short' },
			{ value: 'detailed', label: 'Detailed' }
		]
	}
] as const;

// What the writer is comfortable having drafted or commented on, one choice
// per content warning on the admin's list. Stored under "warning:" and the
// warning's slug; the names come from the live list (see
// #lib/server/assistant-preferences), and a warning since removed or merged
// away drops out.
export const WARNING_PREFIX = 'warning:';
export const CONTENT_LIMITS = [
	{ value: 'write', label: 'Write freely' },
	{ value: 'avoid', label: 'Keep it off the page' }
] as const;
export type ContentLimit = (typeof CONTENT_LIMITS)[number]['value'];
// A bound on the warning keys an import brings in, so a crafted file cannot
// grow the object without end; far more than any list an admin keeps.
const MAX_WARNING_KEYS = 100;
const MAX_WARNING_SLUG = 100;

// A story's choice to stop its universe's notes standing in for its own blank
// notes. Only "no" is stored; absent, the universe's notes are used.
export const USE_UNIVERSE_NOTES = 'useUniverseNotes';

export type HouseStyleKey = (typeof HOUSE_STYLE)[number]['key'];
export type HouseStyleValue<K extends HouseStyleKey> = Extract<
	(typeof HOUSE_STYLE)[number],
	{ key: K }
>['options'][number]['value'];
export type HabitCheck = (typeof HABIT_CHECKS)[number]['key'];
export type CheckChoice = 'check' | 'leave';
export type ChoiceKey = (typeof ASSISTANT_CHOICES)[number]['key'];
export type ChoiceValue<K extends ChoiceKey> = Extract<
	(typeof ASSISTANT_CHOICES)[number],
	{ key: K }
>['options'][number]['value'];

// What is stored on a story or a universe: only the keys that are set.
export type StoredPreferences = { [K in HouseStyleKey]?: HouseStyleValue<K> } & {
	[K in HabitCheck]?: CheckChoice;
} & { [K in ChoiceKey]?: ChoiceValue<K> } & {
	draftWords?: number;
	useUniverseNotes?: 'no';
	[warning: `${typeof WARNING_PREFIX}${string}`]: ContentLimit | undefined;
};

// What the prompts are given: every house-style key (null when not set), the
// habits to leave alone, the writer's own notes, each feedback and length
// choice (null when not set), the default draft length, and the content
// limits by the warning's name.
export type PreferenceSetting = {
	houseStyle: { [K in HouseStyleKey]: HouseStyleValue<K> | null };
	leaveAlone: HabitCheck[];
	notes: string | null;
	feedback: ChoiceValue<'feedback'> | null;
	editReasons: ChoiceValue<'editReasons'> | null;
	summaryLength: ChoiceValue<'summaryLength'> | null;
	draftWords: number | null;
	// id keys a limit (see reviewSettingsKey); name is what prompts state.
	contentLimits: { id: string; name: string; limit: ContentLimit }[];
};

// A content warning on the admin's live list, with the slugs of the warnings
// merged into it (see liveWarnings), whose limits it takes on.
export type LiveWarning = { id: string; name: string; slug: string; merged: string[] };

export const NO_PREFERENCES: PreferenceSetting = {
	houseStyle: { quoteMarks: null, serialComma: null, thoughts: null, tense: null, narration: null },
	leaveAlone: [],
	notes: null,
	feedback: null,
	editReasons: null,
	summaryLength: null,
	draftWords: null,
	contentLimits: []
};

// The blank choice of a story setting that follows its universe's, for the
// preference and language selects alike. Standalone stories share a hidden
// universe the writer knows as the settings for standalone stories.
export function inheritedChoiceLabel(standalone: boolean): string {
	return standalone ? 'Use the standalone default' : "Use the universe's";
}

// The blank choice of a select on the preferences form, naming what it falls
// back to. On a universe (no inherited preferences) that is the fallback
// itself. On a story it is the universe's choice, or the fallback where the
// universe has none: "Not set" for a house style or a content limit, "Check"
// for a habit, and the Assistant's default for a feedback or length choice.
export function inheritedLabel(
	key: string,
	inherited: StoredPreferences | null,
	fallback: string,
	standalone: boolean
): string {
	if (!inherited) return fallback;
	const value = (inherited as Record<string, string | number | undefined>)[key];
	const list =
		HOUSE_STYLE.find((item) => item.key === key) ??
		ASSISTANT_CHOICES.find((item) => item.key === key);
	const label = list
		? list.options.find((option) => option.value === value)?.label
		: key.startsWith(WARNING_PREFIX)
			? CONTENT_LIMITS.find((option) => option.value === value)?.label
			: HABIT_CHECKS.some((item) => item.key === key)
				? value === 'leave'
					? 'Leave alone'
					: 'Check'
				: undefined;
	return `${inheritedChoiceLabel(standalone)}: ${label ?? fallback}`;
}

// The cap on the free-text field, in characters.
export const MAX_ASSISTANT_NOTES = 1000;

const CHECK_CHOICES: readonly string[] = ['check', 'leave'];
const LIMIT_CHOICES: readonly string[] = CONTENT_LIMITS.map((option) => option.value);

function houseStyleValue(key: HouseStyleKey, value: unknown): string | null {
	const field = HOUSE_STYLE.find((item) => item.key === key)!;
	return field.options.some((option) => option.value === value) ? (value as string) : null;
}

function choiceValue(key: ChoiceKey, value: unknown): string | null {
	const field = ASSISTANT_CHOICES.find((item) => item.key === key)!;
	return field.options.some((option) => option.value === value) ? (value as string) : null;
}

// A default draft length: a whole number of words in the range a draft may be
// asked for, given as a number or as digits (an imported line, a form field).
function draftWordsValue(value: unknown): number | null {
	const words =
		typeof value === 'number'
			? value
			: typeof value === 'string' && /^\d+$/.test(value.trim())
				? Number(value)
				: NaN;
	return Number.isInteger(words) && words >= MIN_DRAFT_WORDS && words <= MAX_DRAFT_WORDS
		? words
		: null;
}

// Whether a key names a content warning by slug: the prefix, then a slug of
// sane length on one line.
export function isWarningKey(key: string): boolean {
	if (!key.startsWith(WARNING_PREFIX)) return false;
	const slug = key.slice(WARNING_PREFIX.length);
	return (
		slug.trim() !== '' &&
		slug.length <= MAX_WARNING_SLUG &&
		!/[\n\r]/.test(slug) &&
		!slug.includes('\u0000')
	);
}

export const warningKey = (slug: string) => `${WARNING_PREFIX}${slug}`;

// A stored or submitted object as the known keys with valid values; anything
// else (an unknown key, a value since dropped from a list, not an object at
// all) reads as not set.
export function normalisePreferences(raw: unknown): StoredPreferences {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const source = raw as Record<string, unknown>;
	const out: Record<string, string | number> = {};
	for (const { key } of HOUSE_STYLE) {
		const value = houseStyleValue(key, source[key]);
		if (value) out[key] = value;
	}
	for (const { key } of HABIT_CHECKS) {
		if (CHECK_CHOICES.includes(source[key] as string)) out[key] = source[key] as string;
	}
	for (const { key } of ASSISTANT_CHOICES) {
		const value = choiceValue(key, source[key]);
		if (value) out[key] = value;
	}
	const words = draftWordsValue(source.draftWords);
	if (words !== null) out.draftWords = words;
	if (source[USE_UNIVERSE_NOTES] === 'no') out[USE_UNIVERSE_NOTES] = 'no';
	for (const key of Object.keys(source)) {
		if (isWarningKey(key) && LIMIT_CHOICES.includes(source[key] as string)) {
			out[key] = source[key] as string;
		}
	}
	return out as StoredPreferences;
}

// The stored preferences as "key: value" lines, the way an export's front
// matter lists them, and back. A line that names no known key or value is
// counted as unread rather than kept. A line splits at its last colon: no
// value holds one, but a warning's slug may.
export function preferenceLines(raw: unknown): string[] {
	return Object.entries(normalisePreferences(raw)).map(([key, value]) => `${key}: ${value}`);
}

export function preferencesFromLines(lines: string[]): {
	preferences: StoredPreferences;
	unread: number;
} {
	const raw: Record<string, string> = {};
	for (const line of lines) {
		const colon = line.lastIndexOf(':');
		if (colon > 0) raw[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
	}
	// The form only stores warnings on the live list, so an import is the one
	// way in for any slug; it is capped here.
	let warnings = 0;
	const capped = Object.fromEntries(
		Object.entries(raw).filter(
			([key, value]) =>
				!isWarningKey(key) || (LIMIT_CHOICES.includes(value) && ++warnings <= MAX_WARNING_KEYS)
		)
	);
	const preferences = normalisePreferences(capped);
	return { preferences, unread: lines.length - Object.keys(preferences).length };
}

// The lines the prompts put around the notes.
export const NOTES_BEGIN = "--- the writer's notes ---";
export const NOTES_END = '--- end of the notes ---';

// The free text as the writer typed it, trimmed, with Windows line ends (a
// submitted form sends CRLF) as plain newlines and null characters dropped;
// blank is not set. The prompts fence it (habitNotesLine), and keep it from
// reading as a fence line there, not here.
export function normaliseNotes(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const text = raw.replace(/\r\n?/g, '\n').replaceAll('\u0000', '').trim();
	return text || null;
}

// The preferences a story works under: each key the story's own, else the
// universe's, else not set; the story's notes, else the universe's unless the
// story turned those off (only the story's own choice counts). warnings is
// the live list of content warnings; a limit on a slug not on it, or merged
// into one on it, is left out, and with no list given there are no content
// limits.
//
// A warning's limit folds in the limits on the warnings merged into it, so a
// merge needs no copying and an undone merge leaves nothing behind: each of
// those slugs resolves as the story's own, else the universe's, and the
// warning is "avoid" when any of them is, else "write" when any is.
export function effectivePreferences(
	story: { preferences: unknown; notes: string | null | undefined } | null,
	universe: { preferences: unknown; notes: string | null | undefined } | null,
	warnings: readonly LiveWarning[] = []
): PreferenceSetting {
	const own = normalisePreferences(story?.preferences);
	const inherited = normalisePreferences(universe?.preferences);
	const merged: StoredPreferences = { ...inherited, ...own };
	const houseStyle = { ...NO_PREFERENCES.houseStyle };
	for (const { key } of HOUSE_STYLE) {
		(houseStyle as Record<string, string | null>)[key] = merged[key] ?? null;
	}
	const contentLimits = warnings
		.map(({ id, name, slug, merged: folded }) => {
			const limits = [slug, ...folded].map(
				(each) => merged[warningKey(each) as `warning:${string}`]
			);
			const limit: ContentLimit | undefined = limits.includes('avoid')
				? 'avoid'
				: limits.includes('write')
					? 'write'
					: undefined;
			return { id, name, limit };
		})
		.filter((entry): entry is { id: string; name: string; limit: ContentLimit } =>
			Boolean(entry.limit)
		);
	return {
		houseStyle,
		leaveAlone: HABIT_CHECKS.filter(({ key }) => merged[key] === 'leave').map(({ key }) => key),
		notes:
			normaliseNotes(story?.notes) ??
			(own[USE_UNIVERSE_NOTES] === 'no' ? null : normaliseNotes(universe?.notes)),
		feedback: merged.feedback ?? null,
		editReasons: merged.editReasons ?? null,
		summaryLength: merged.summaryLength ?? null,
		draftWords: merged.draftWords ?? null,
		contentLimits
	};
}

export type PreferencesForm =
	| {
			ok: true;
			changes: PreferenceChanges;
			notes: string | null | undefined;
			// The form showed a warning no longer on the list, so no limits were
			// read (see readPreferencesForm).
			outdated?: true;
	  }
	| { ok: false; reason: string; submitted: SubmittedPreferences };

// The keys a form carried: a value to store, or null to clear back to not
// set. A key the post did not carry is left as stored.
export type PreferenceChanges = Record<string, string | number | null>;

// The form's values as submitted, handed back on a refusal so the page shows
// them again instead of losing what was typed.
export type SubmittedPreferences = Record<string, string>;

const FIELD_KEYS = [
	...HOUSE_STYLE.map((item) => item.key),
	...HABIT_CHECKS.map((item) => item.key),
	...ASSISTANT_CHOICES.map((item) => item.key),
	'draftWords',
	USE_UNIVERSE_NOTES,
	'assistantNotes'
];

// The preferences form as submitted: one select per key (blank is not set),
// the draft length (blank is not set), one select per content warning, and
// the notes (undefined when the post lacks the field, so they are kept). A
// value that is not on its list is refused rather than dropped, so a tampered
// form does not silently clear a setting.
//
// The form posts a select for every warning it shows, and a warning is read
// only when it is on the live list (liveSlugs). A form that posts a warning no
// longer on the list was opened before that warning was renamed, merged away
// or removed, so its limits may not show what the list's changes moved there:
// it is marked outdated and none of its limits are read, which leaves every
// stored limit as it is. Its other fields save as usual.
export function readPreferencesForm(
	data: FormData,
	liveSlugs: readonly string[] = []
): PreferencesForm {
	const live = new Set(liveSlugs);
	const posted = [...new Set(data.keys())].filter((key) => key.startsWith(WARNING_PREFIX));
	const outdated = posted.some((key) => !live.has(key.slice(WARNING_PREFIX.length)));
	const warningKeys = outdated
		? []
		: liveSlugs.map(warningKey).filter((key) => isWarningKey(key) && data.has(key));
	const submitted: SubmittedPreferences = {};
	for (const key of [...FIELD_KEYS, ...warningKeys]) {
		const raw = data.get(key);
		submitted[key] = typeof raw === 'string' ? raw : '';
	}
	const refuse = (reason: string): PreferencesForm => ({ ok: false, reason, submitted });
	const changes: PreferenceChanges = {};
	for (const { key } of HOUSE_STYLE) {
		if (!data.has(key)) continue;
		const raw = submitted[key].trim();
		if (raw && !houseStyleValue(key, raw)) return refuse('Pick each setting from its list.');
		changes[key] = raw || null;
	}
	for (const { key } of HABIT_CHECKS) {
		if (!data.has(key)) continue;
		const raw = submitted[key].trim();
		if (raw && !CHECK_CHOICES.includes(raw)) return refuse('Pick each setting from its list.');
		changes[key] = raw || null;
	}
	for (const { key } of ASSISTANT_CHOICES) {
		if (!data.has(key)) continue;
		const raw = submitted[key].trim();
		if (raw && !choiceValue(key, raw)) return refuse('Pick each setting from its list.');
		changes[key] = raw || null;
	}
	for (const key of warningKeys) {
		const raw = submitted[key].trim();
		if (raw && !LIMIT_CHOICES.includes(raw)) return refuse('Pick each setting from its list.');
		changes[key] = raw || null;
	}
	if (data.has(USE_UNIVERSE_NOTES)) {
		const raw = submitted[USE_UNIVERSE_NOTES].trim();
		if (raw && raw !== 'no') return refuse('Pick each setting from its list.');
		changes[USE_UNIVERSE_NOTES] = raw || null;
	}
	if (data.has('draftWords')) {
		const raw = submitted.draftWords.trim();
		const words = draftWordsValue(raw);
		if (raw && words === null) {
			return refuse(
				`Give a draft length in whole words, from ${MIN_DRAFT_WORDS} to ${MAX_DRAFT_WORDS}.`
			);
		}
		changes.draftWords = words;
	}
	const notes = data.has('assistantNotes') ? normaliseNotes(submitted.assistantNotes) : undefined;
	if (notes && notes.length > MAX_ASSISTANT_NOTES) {
		return refuse(`Keep your notes to ${MAX_ASSISTANT_NOTES} characters or fewer.`);
	}
	return outdated ? { ok: true, changes, notes, outdated } : { ok: true, changes, notes };
}
