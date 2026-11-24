import { describe, expect, it } from 'vitest';
import { NO_LANGUAGE, type LanguageSetting } from '../../../writing-languages.ts';
import { REVIEW_CATEGORIES } from '../../../review-shape.ts';
import {
	languageRule,
	nativeInterferenceLine,
	nativePatternLine,
	spellingCheckLine,
	writeInLine
} from './language.ts';
import { IN_CONTEXT } from './format.ts';
import {
	buildPatternApplyMessage,
	buildPatternBrief,
	buildPatternSurveyMessage,
	buildRereadMessage,
	buildReviewMessage
} from './review.ts';
import { buildSceneDraftMessage } from './scene-draft.ts';
import { buildCoauthorMessage } from './coauthor.ts';
import { buildContinuationMessage } from './continuation.ts';
import { buildSceneSummaryMessage } from './summary.ts';
import { buildArcMessage } from './arc.ts';
import { buildRecapMessage } from './recap.ts';

const UK: LanguageSetting = { language: 'en-GB', native: null };
const UK_DANE: LanguageSetting = { language: 'en-GB', native: 'da' };

describe('language prompt lines', () => {
	it('states the language and spelling convention when set, and nothing when not', () => {
		expect(languageRule(UK)).toBe(
			'The story is written in British English. Write in British English, and keep to British English spelling and usage.'
		);
		expect(languageRule(NO_LANGUAGE)).toBe('');
	});

	it('names the language to write a summary in, or keeps the fallback', () => {
		expect(writeInLine({ language: 'da', native: null }, 'Write in the same language.')).toBe(
			'Write in Danish.'
		);
		expect(writeInLine(NO_LANGUAGE, 'Write in the same language.')).toBe(
			'Write in the same language.'
		);
	});

	it('checks spelling against the set convention, or the one the text uses', () => {
		expect(spellingCheckLine(UK)).toContain('strays from British English');
		expect(spellingCheckLine(NO_LANGUAGE)).toContain('against the convention the text uses');
	});

	it('adds the native-language hint only when it differs from the story language', () => {
		const line = nativeInterferenceLine(UK_DANE);
		expect(line).toContain("the writer's native language is Danish");
		expect(line).toContain('idioms translated word for word, false friends, prepositions');
		expect(line).toContain('what a native writer of British English would write instead');
		expect(line).toContain('not a reason to flag sentences that already read naturally');
		expect(nativeInterferenceLine(UK)).toBe('');
		expect(nativeInterferenceLine({ language: 'da', native: 'da' })).toBe('');
		// Another region of the same language is not interference.
		expect(nativeInterferenceLine({ language: 'en-GB', native: 'en-US' })).toBe('');
		expect(nativePatternLine(UK)).toBe('');
		expect(nativePatternLine(UK_DANE)).toContain('counts as a pattern');
	});

	it('hedges the hint when the story language is not set', () => {
		const line = nativeInterferenceLine({ language: null, native: 'da' });
		expect(line).toContain('Where the text is in another language, look for slips');
		expect(line).toContain("a native writer of the text's language");
	});
});

// Each surface that writes or checks prose carries the line when a language
// is set, and reads exactly as before when none is.
describe('the prompts that state the language', () => {
	const scene = { id: 'scene-1', title: 'The Gate' };
	const rule = languageRule(UK);
	const pattern = { name: 'Epithets', description: 'd', sceneIds: ['s1'], examples: [] };
	const patternScene = { id: 's1', title: 'One', bodyMd: 'Text.' };
	const review = (categories: Parameters<typeof buildReviewMessage>[2], language = UK_DANE) =>
		buildReviewMessage(scene, [], categories, false, false, IN_CONTEXT, language);

	it('review, copyedit and the pattern pass', () => {
		expect(review([], UK)).toContain(rule);
		expect(buildReviewMessage(scene)).not.toContain('The story is written in');
		const copyedit = review([...REVIEW_CATEGORIES]);
		expect(copyedit).toContain(spellingCheckLine(UK_DANE));
		expect(copyedit).toContain(nativeInterferenceLine(UK_DANE));
		// The prose pass looks for the slips too; the lore pass and the sparing
		// review do not.
		expect(review(['prose'])).toContain('Interference from Danish');
		expect(review(['lore'])).not.toContain('Interference from Danish');
		expect(review([])).not.toContain('Interference from Danish');
		expect(
			buildPatternSurveyMessage([patternScene], { scope: 'chapter', cap: 5, language: UK_DANE })
		).toContain(nativePatternLine(UK_DANE));
		expect(buildPatternBrief({ storyId: 'st', cap: 5, language: UK_DANE })).toContain(rule);
		expect(buildPatternApplyMessage(pattern, patternScene, 1000, UK)).toContain(rule);
		expect(
			buildRereadMessage({
				sceneId: 's1',
				sceneTitle: null,
				passage: 'p',
				changed: 'c',
				note: 'n',
				language: UK
			})
		).toContain(rule);
	});

	it('drafts, /write and the continuation', () => {
		expect(buildSceneDraftMessage({ brief: 'b', targetWords: 500, language: UK })).toContain(rule);
		expect(buildSceneDraftMessage({ brief: 'b', targetWords: 500 })).not.toContain(
			'The story is written in'
		);
		expect(buildCoauthorMessage('b', null, { language: UK })).toContain(rule);
		expect(buildContinuationMessage('Once.', UK)).toContain(rule);
		expect(buildContinuationMessage('Once.')).not.toContain('The story is written in');
	});

	it('summaries, arcs and the recap', () => {
		const da = { language: 'da', native: null } as const;
		expect(buildSceneSummaryMessage('T', 'Body.', da)).toContain('Write in Danish.');
		expect(buildSceneSummaryMessage('T', 'Body.')).toContain(
			'Write in the same language as the scene.'
		);
		expect(buildArcMessage('Mara', [], da)).toContain('Write in Danish.');
		expect(buildRecapMessage(null, da)).toContain('Write in Danish.');
		expect(buildRecapMessage(null)).toContain('Write in the same language as the story.');
	});
});
