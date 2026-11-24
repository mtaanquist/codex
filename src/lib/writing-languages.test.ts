import { describe, expect, it } from 'vitest';
import {
	effectiveLanguage,
	isWritingLanguage,
	normaliseLanguage,
	sameLanguage,
	WRITING_LANGUAGES,
	writingLanguageLabel,
	writingLanguageName
} from './writing-languages.ts';

describe('writing languages', () => {
	it('has one entry per tag', () => {
		const tags = WRITING_LANGUAGES.map((language) => language.tag);
		expect(new Set(tags).size).toBe(tags.length);
	});

	it('reads only tags from the list, and anything else as not set', () => {
		expect(normaliseLanguage('en-GB')).toBe('en-GB');
		expect(normaliseLanguage('')).toBeNull();
		expect(normaliseLanguage(null)).toBeNull();
		expect(normaliseLanguage('xx-YY')).toBeNull();
		expect(normaliseLanguage('en-gb')).toBeNull();
		expect(isWritingLanguage('da')).toBe(true);
		expect(isWritingLanguage(42)).toBe(false);
	});

	it("uses the story's own language, else the universe's, else none", () => {
		expect(effectiveLanguage('da', 'en-GB')).toBe('da');
		expect(effectiveLanguage(null, 'en-GB')).toBe('en-GB');
		expect(effectiveLanguage(undefined, undefined)).toBeNull();
		// A value no longer in the list falls through as if unset.
		expect(effectiveLanguage('xx', 'en-US')).toBe('en-US');
	});

	it('treats regions of one language as the same language', () => {
		expect(sameLanguage('en-GB', 'en-US')).toBe(true);
		expect(sameLanguage('da', 'en-GB')).toBe(false);
		expect(sameLanguage('nb', 'nb')).toBe(true);
	});

	it('names a language for the settings and for the prompts', () => {
		expect(writingLanguageLabel('en-GB')).toBe('English (UK)');
		expect(writingLanguageLabel('xx')).toBe('xx');
		expect(writingLanguageName('en-US')).toBe('American English');
	});
});
