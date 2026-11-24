// The prompt lines that state a story's language and spelling convention and
// the writer's native language, written once here for every surface (the
// Assistant's and the MCP prompts). Each returns '' or its fallback when
// nothing is set, so a prompt with no language setting reads as it did before
// the setting existed.

import {
	sameLanguage,
	writingLanguageName,
	type LanguageSetting,
	type WritingLanguage
} from '../../../writing-languages.ts';

// For work that writes or edits prose: the language, and that its spelling
// and usage hold.
export function languageRule(setting: LanguageSetting): string {
	if (!setting.language) return '';
	const name = writingLanguageName(setting.language);
	return `The story is written in ${name}. Write in ${name}, and keep to ${name} spelling and usage.`;
}

// For the chat in a story: prose it writes keeps to the story's language, but
// it answers the writer in whatever language they write to it in.
export function chatLanguageRule(setting: LanguageSetting): string {
	if (!setting.language) return '';
	const name = writingLanguageName(setting.language);
	return `The story is written in ${name}. Write prose, passages and suggested edits in ${name}, keeping to ${name} spelling and usage. Answer the writer in the language they write to you in.`;
}

// For a summary, an arc or a recap: the language to write it in, or the
// caller's own "same language as ..." line when none is set.
export function writeInLine(setting: LanguageSetting, fallback: string): string {
	return setting.language ? `Write in ${writingLanguageName(setting.language)}.` : fallback;
}

// The word-choice line of the mechanics category: checked against the set
// convention, or against the one the text uses when none is set.
export function spellingCheckLine(setting: LanguageSetting): string {
	return setting.language
		? `- Word choice and idiom: wrong homophones, malformed idioms, and spelling or usage that strays from ${writingLanguageName(setting.language)}.`
		: '- Word choice and idiom: wrong homophones, malformed idioms, regional spelling consistency (British vs American) against the convention the text uses.';
}

// The native language worth a hint: set, and a different language from the
// story's. With no story language set there is nothing to compare, so no hint.
function interferingNative(
	setting: LanguageSetting
): { native: WritingLanguage; language: WritingLanguage } | null {
	const { language, native } = setting;
	if (!native || !language || sameLanguage(language, native)) return null;
	return { native, language };
}

// For copyedit and prose review: slips carried over from the writer's native
// language, as a place to look rather than a reason to flag every sentence.
export function nativeInterferenceLine(setting: LanguageSetting): string {
	const pair = interferingNative(setting);
	if (!pair) return '';
	const from = writingLanguageName(pair.native);
	return [
		`- Interference from ${from}: the writer's native language is ${from}.`,
		`Look for slips carried over from ${from}: idioms translated word for word, false friends, prepositions, word order, article use, comma habits, and compound words written as one.`,
		`For each, say what a native writer of ${writingLanguageName(pair.language)} would write instead.`,
		'Treat this as a hint of where to look, not a reason to flag sentences that already read naturally.'
	].join(' ');
}

// For the pattern pass: a slip from the native language that recurs is a
// habit like any other.
export function nativePatternLine(setting: LanguageSetting): string {
	const pair = interferingNative(setting);
	if (!pair) return '';
	const from = writingLanguageName(pair.native);
	return `The writer's native language is ${from}. A slip carried over from ${from} that recurs (an idiom translated word for word, a false friend, a preposition, word order, article use, a comma habit, a compound written as one) counts as a pattern; name it as one so the writer can learn the habit.`;
}
