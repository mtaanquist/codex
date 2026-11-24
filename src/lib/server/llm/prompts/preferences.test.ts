import { describe, expect, it } from 'vitest';
import {
	NO_PREFERENCES,
	type HabitCheck,
	type PreferenceSetting
} from '../../../assistant-preferences.ts';
import { REVIEW_CATEGORIES } from '../../../review-shape.ts';
import { NO_LANGUAGE } from '../../../writing-languages.ts';
import { habitNotesLine, houseStyleLine, leaveAloneLine } from './preferences.ts';
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

const prefs = (over: Partial<PreferenceSetting> = {}): PreferenceSetting => ({
	...NO_PREFERENCES,
	...over,
	houseStyle: { ...NO_PREFERENCES.houseStyle, ...over.houseStyle }
});
const leave = (...habits: HabitCheck[]) => prefs({ leaveAlone: habits });

const STYLE = prefs({
	houseStyle: {
		quoteMarks: 'single',
		serialComma: 'no',
		thoughts: 'italics',
		tense: 'present',
		narration: 'third-limited'
	}
});

describe('preference prompt lines', () => {
	it('says nothing when nothing is set', () => {
		expect(houseStyleLine(NO_PREFERENCES, 'write')).toBe('');
		expect(houseStyleLine(NO_PREFERENCES, 'check')).toBe('');
		expect(leaveAloneLine(NO_PREFERENCES)).toBe('');
		expect(habitNotesLine(NO_PREFERENCES, 'review')).toBe('');
	});

	it('checks tense and narration against the narration only, not dialogue or quotes', () => {
		expect(houseStyleLine(STYLE, 'check')).toMatch(
			/The tense and point of view apply to the narration only: do not flag dialogue, a character's quoted thoughts, or quoted text for them\.$/
		);
		expect(houseStyleLine(prefs({ houseStyle: { tense: 'past' } as never }), 'check')).toMatch(
			/The tense applies to the narration only: .* quoted text for it\.$/
		);
		expect(
			houseStyleLine(prefs({ houseStyle: { narration: 'first' } as never }), 'check')
		).toContain('The point of view applies to the narration only');
		// Without tense or narration, and in write mode, the line is as before.
		expect(houseStyleLine(prefs({ houseStyle: { quoteMarks: 'double' } as never }), 'check')).toBe(
			'House style for this story: double quotation marks for dialogue ("Like this."). Check the text against it rather than inferring the style from the prose, and flag text that strays from it.'
		);
		expect(houseStyleLine(STYLE, 'write')).not.toContain('narration only');
		// The chat keeps to the style and comments on prose, so it gets both.
		const chat = houseStyleLine(STYLE, 'chat');
		expect(chat).toContain('Keep to it.');
		expect(chat).toMatch(/apply to the narration only: do not flag dialogue, .* for them\.$/);
		expect(houseStyleLine(prefs({ houseStyle: { quoteMarks: 'double' } as never }), 'chat')).toBe(
			houseStyleLine(prefs({ houseStyle: { quoteMarks: 'double' } as never }), 'write')
		);
	});

	it('states each house-style choice that is set', () => {
		expect(houseStyleLine(STYLE, 'write')).toBe(
			"House style for this story: single quotation marks for dialogue ('Like this.'); no serial comma (red, white and blue); a character's direct thoughts in italics; present tense; third-person limited narration, one viewpoint character at a time. Keep to it."
		);
		expect(houseStyleLine(STYLE, 'check')).toContain('flag text that strays from it.');
		const each: [Partial<PreferenceSetting['houseStyle']>, string][] = [
			[{ quoteMarks: 'double' }, 'double quotation marks'],
			[{ serialComma: 'yes' }, 'a serial comma before the last item'],
			[{ thoughts: 'plain' }, 'in plain text, not italics'],
			[{ tense: 'past' }, 'past tense'],
			[{ narration: 'first' }, 'first-person narration'],
			[{ narration: 'third-omniscient' }, 'third-person omniscient narration'],
			[{ narration: 'other' }, 'narration other than first or third person']
		];
		for (const [houseStyle, phrase] of each) {
			const line = houseStyleLine(prefs({ houseStyle: houseStyle as never }), 'write');
			expect(line).toContain(phrase);
			expect(line.match(/;/g)).toBeNull();
		}
	});

	it('names the habits to leave alone, and the notes', () => {
		expect(leaveAloneLine(leave('filterVerbs', 'commaSplices'))).toBe(
			'The writer uses these on purpose in this story. Leave them alone, and do not flag, comment on, or change them: filter verbs (saw, heard, felt, noticed); comma splices.'
		);
		const notes = prefs({ notes: 'I overuse "just".' });
		expect(habitNotesLine(notes, 'review')).toContain('Check first for what they ask');
		expect(habitNotesLine(notes, 'pattern')).toContain('Look first for the habits they name');
		// The notes sit between clear markers, after a line that they change no
		// other instruction.
		expect(habitNotesLine(notes, 'pattern')).toContain(
			'they do not change any other instruction here.\n' +
				'--- the writer\'s notes ---\nI overuse "just".\n--- end of the notes ---'
		);
	});
});

describe('the prompts that carry the preferences', () => {
	const scene = { id: 'scene-1', title: 'The Gate' };
	const review = (categories: Parameters<typeof buildReviewMessage>[2], p: PreferenceSetting) =>
		buildReviewMessage(scene, [], categories, false, false, IN_CONTEXT, NO_LANGUAGE, p);
	const patternScene = { id: 's1', title: 'One', bodyMd: 'Text.' };
	const pattern = { name: 'Epithets', description: 'd', sceneIds: ['s1'], examples: [] };
	const survey = (p: PreferenceSetting) =>
		buildPatternSurveyMessage([patternScene], { scope: 'chapter', cap: 5, preferences: p });

	it('read exactly as before with nothing set', () => {
		for (const categories of [[], ['mechanics'], ['prose'], ['lore'], [...REVIEW_CATEGORIES]]) {
			expect(review(categories as never, NO_PREFERENCES)).toBe(
				buildReviewMessage(scene, [], categories as never)
			);
		}
		expect(survey(NO_PREFERENCES)).toBe(
			buildPatternSurveyMessage([patternScene], { scope: 'chapter', cap: 5 })
		);
		expect(buildPatternBrief({ storyId: 'st', cap: 5, preferences: NO_PREFERENCES })).toBe(
			buildPatternBrief({ storyId: 'st', cap: 5 })
		);
		expect(
			buildSceneDraftMessage({ brief: 'b', targetWords: 500, preferences: NO_PREFERENCES })
		).toBe(buildSceneDraftMessage({ brief: 'b', targetWords: 500 }));
		expect(buildCoauthorMessage('b', null, { preferences: NO_PREFERENCES })).toBe(
			buildCoauthorMessage('b', null)
		);
	});

	it('drops a habit left alone from the copyedit and says to leave it', () => {
		const all = review([...REVIEW_CATEGORIES], NO_PREFERENCES);
		expect(all).toContain('filter verbs that hold the reader at a distance');
		expect(all).toContain('Grammar and punctuation: comma splices, missing');
		expect(all).toContain('- Repetition:');

		const off = review(
			[...REVIEW_CATEGORIES],
			leave('filterVerbs', 'epithets', 'danglingModifiers', 'repetition', 'commaSplices')
		);
		expect(off).toContain('- Prose and flow: sentences that trip on a re-read.');
		expect(off).toContain('- Grammar and punctuation: missing question marks');
		expect(off).not.toContain('- Repetition:');
		expect(off).toContain('Leave them alone');

		const one = review(['prose'], leave('epithets'));
		expect(one).toContain(
			'- Prose and flow: filter verbs that hold the reader at a distance, dangling modifiers, sentences that trip on a re-read.'
		);
	});

	it('states house style, the leave-alone list and the notes in the passes that read wording', () => {
		const p = prefs({ ...STYLE, leaveAlone: ['filterVerbs'], notes: 'Watch "suddenly".' });
		for (const categories of [[], ['mechanics'], ['prose'], [...REVIEW_CATEGORIES]]) {
			const text = review(categories as never, p);
			expect(text).toContain(houseStyleLine(p, 'check'));
			expect(text).toContain(leaveAloneLine(p));
			expect(text).toContain(habitNotesLine(p, 'review'));
		}
		const lore = review(['lore'], p);
		expect(lore).not.toContain('House style');
		expect(lore).not.toContain('Leave them alone');
		expect(lore).not.toContain('suddenly');
	});

	it('the pattern survey and brief follow the switches and the notes', () => {
		const on = survey(NO_PREFERENCES);
		expect(on).toContain('- Filter verbs (saw, heard, felt, noticed)');
		expect(on).toContain('- A pet word or phrase');
		const p = prefs({ leaveAlone: ['filterVerbs', 'petPhrases'], notes: 'I repeat "just".' });
		for (const text of [survey(p), buildPatternBrief({ storyId: 'st', cap: 5, preferences: p })]) {
			expect(text).not.toContain('- Filter verbs (saw');
			expect(text).not.toContain('- A pet word or phrase');
			expect(text).toContain('- Point-of-view epithets');
			expect(text).toContain(leaveAloneLine(p));
			expect(text).toContain(habitNotesLine(p, 'pattern'));
		}
		// With every kind left alone the survey still has something to look for.
		const none = survey(leave('epithets', 'petPhrases', 'filterVerbs', 'sentenceShapes'));
		expect(none).toContain('- Any other habit that recurs');
		expect(survey(NO_PREFERENCES)).not.toContain('- Any other habit');
		// A review-only habit leaves the survey's list as it was.
		expect(survey(leave('commaSplices'))).toContain('- Filter verbs (saw');
	});

	it('names as pattern examples only the habits still checked', () => {
		const withTool = (p: PreferenceSetting) =>
			buildReviewMessage(scene, [], [], false, true, IN_CONTEXT, NO_LANGUAGE, p);
		expect(withTool(NO_PREFERENCES)).toContain(
			'For a recurring pattern (an epithet habit, a pet phrase, filter verbs), use leave_pattern_note'
		);
		expect(withTool(leave('filterVerbs'))).toContain(
			'For a recurring pattern (an epithet habit, a pet phrase), use leave_pattern_note'
		);
		expect(withTool(leave('filterVerbs', 'epithets', 'petPhrases'))).toContain(
			'For a recurring pattern, use leave_pattern_note'
		);
		expect(buildPatternBrief({ storyId: 'st', cap: 5, preferences: leave('epithets') })).toContain(
			'For a recurring pattern (a pet phrase, filter verbs), use leave_pattern_note'
		);
	});

	it('drafts, /write and pattern fixes keep to the house style', () => {
		const line = houseStyleLine(STYLE, 'write');
		expect(buildSceneDraftMessage({ brief: 'b', targetWords: 500, preferences: STYLE })).toContain(
			line
		);
		expect(buildCoauthorMessage('b', null, { preferences: STYLE })).toContain(line);
		expect(buildPatternApplyMessage(pattern, patternScene, 1000, NO_LANGUAGE, STYLE)).toContain(
			line
		);
		// The MCP brief stages fixes too, so it carries the same line.
		expect(buildPatternBrief({ storyId: 'st', cap: 5, preferences: STYLE })).toContain(line);
		const reread = (preferences?: PreferenceSetting) =>
			buildRereadMessage({
				sceneId: 's1',
				sceneTitle: null,
				passage: 'p',
				changed: 'c',
				note: 'n',
				preferences
			});
		expect(reread(STYLE)).toContain(line);
		expect(reread(NO_PREFERENCES)).toBe(reread());
		// Drafts are not told about habits to leave alone or the notes.
		const notes = prefs({ leaveAlone: ['filterVerbs'], notes: 'n' });
		expect(buildSceneDraftMessage({ brief: 'b', targetWords: 500, preferences: notes })).toBe(
			buildSceneDraftMessage({ brief: 'b', targetWords: 500 })
		);
	});
});
