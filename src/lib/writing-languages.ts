// The languages a writer can pick: the spell-check language in the editor
// preferences, a universe's or story's language and spelling convention, and
// the writer's native language. Each tag is a BCP 47 tag the browser's
// spell-checker understands. `name` is how the Assistant's prompts say it
// ("Write in British English."). The editor preference also accepts any
// valid tag; the story, universe and native settings take only these.
export const WRITING_LANGUAGES = [
	{ tag: 'da', label: 'Danish', name: 'Danish' },
	{ tag: 'nl', label: 'Dutch', name: 'Dutch' },
	{ tag: 'en-AU', label: 'English (Australia)', name: 'Australian English' },
	{ tag: 'en-CA', label: 'English (Canada)', name: 'Canadian English' },
	{ tag: 'en-GB', label: 'English (UK)', name: 'British English' },
	{ tag: 'en-US', label: 'English (US)', name: 'American English' },
	{ tag: 'fi', label: 'Finnish', name: 'Finnish' },
	{ tag: 'fr', label: 'French', name: 'French' },
	{ tag: 'de', label: 'German', name: 'German' },
	{ tag: 'it', label: 'Italian', name: 'Italian' },
	{ tag: 'nb', label: 'Norwegian', name: 'Norwegian Bokmal' },
	{ tag: 'pl', label: 'Polish', name: 'Polish' },
	{ tag: 'pt', label: 'Portuguese', name: 'Portuguese' },
	{ tag: 'es', label: 'Spanish', name: 'Spanish' },
	{ tag: 'sv', label: 'Swedish', name: 'Swedish' }
] as const;

export type WritingLanguage = (typeof WRITING_LANGUAGES)[number]['tag'];

// What the Assistant is told about the language of a piece of work: the
// story's (or universe's) language and the writer's native language, each a
// tag from the list or null when not set.
export type LanguageSetting = { language: WritingLanguage | null; native: WritingLanguage | null };

export const NO_LANGUAGE: LanguageSetting = { language: null, native: null };

export function writingLanguageLabel(tag: string): string {
	return WRITING_LANGUAGES.find((language) => language.tag === tag)?.label ?? tag;
}

export function writingLanguageName(tag: WritingLanguage): string {
	return WRITING_LANGUAGES.find((language) => language.tag === tag)!.name;
}

export function isWritingLanguage(value: unknown): value is WritingLanguage {
	return WRITING_LANGUAGES.some((language) => language.tag === value);
}

// A stored or submitted value as a tag from the list; anything else (blank,
// a tag since dropped from the list) reads as not set.
export function normaliseLanguage(value: unknown): WritingLanguage | null {
	return isWritingLanguage(value) ? value : null;
}

// The language a story is written in: its own, else its universe's, else
// none (the Assistant infers it from the text).
export function effectiveLanguage(
	story: string | null | undefined,
	universe: string | null | undefined
): WritingLanguage | null {
	return normaliseLanguage(story) ?? normaliseLanguage(universe);
}

// Whether two tags are the same language, region aside: en-GB and en-US are,
// so an English writer working in the other spelling gets no native-language
// hint (the spelling convention covers that).
export function sameLanguage(a: string, b: string): boolean {
	return a.split('-')[0].toLowerCase() === b.split('-')[0].toLowerCase();
}
