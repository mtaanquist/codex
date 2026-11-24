import { describe, expect, it } from 'vitest';
import { buildMcpPrompt } from '../../mcp/prompts.ts';
import { NO_LANGUAGE } from '../../../writing-languages.ts';
import { NO_PREFERENCES } from '../../../assistant-preferences.ts';
import { IN_CONTEXT } from './format.ts';
import { buildArcMessage } from './arc.ts';
import { buildCoauthorMessage } from './coauthor.ts';
import { buildContinuationMessage } from './continuation.ts';
import { buildRecapMessage } from './recap.ts';
import {
	buildPatternApplyMessage,
	buildPatternBrief,
	buildPatternSurveyMessage,
	buildRereadMessage,
	buildReviewMessage
} from './review.ts';
import { buildSceneDraftMessage } from './scene-draft.ts';
import { buildChapterSummaryMessage, buildSceneSummaryMessage } from './summary.ts';
import { renderFrame } from '../context/assemble.ts';
import before from './unset-language.fixture.json';

// The chat's story frame, which states the language and house style when set.
const frameScope = {
	storyId: 's',
	universeId: 'u',
	storyTitle: 'The Gate',
	storyBrief: 'A brief.',
	storyDescription: null,
	storyStyleNotes: 'Literary.',
	universeName: 'Vael',
	universeDescription: 'A world.',
	universeEstablished: false
};

// With no language set, every prompt is exactly what it was before the
// language setting existed (#1343): the fixture holds these prompts as the
// release before it built them. A deliberate change to one of them updates
// the fixture with it.
describe('prompts with no language set', () => {
	it('are byte-identical to before the setting', () => {
		const scene = { id: 'scene-1', title: 'The Gate' };
		const ps = { id: 's1', title: 'One', bodyMd: 'Text.' };
		const ids = {
			universeId: '11111111-1111-4111-8111-111111111111',
			storyId: '22222222-2222-4222-8222-222222222222',
			sceneId: '33333333-3333-4333-8333-333333333333',
			brief: 'b',
			chapter: 'One',
			passage: 'p',
			instruction: 'i'
		};
		const connection = { permissions: ['read', 'suggest'] as const, language: NO_LANGUAGE };
		const now: Record<string, string> = {
			review: buildReviewMessage(scene),
			copyedit: buildReviewMessage(scene, [], ['mechanics', 'prose', 'lore']),
			patternSurvey: buildPatternSurveyMessage([ps], { scope: 'chapter', cap: 5 }),
			patternBrief: buildPatternBrief({ storyId: 'st', cap: 5 }),
			patternApply: buildPatternApplyMessage(
				{ name: 'E', description: 'd', sceneIds: ['s1'], examples: [] },
				ps,
				1000
			),
			reread: buildRereadMessage({
				sceneId: 's1',
				sceneTitle: null,
				passage: 'p',
				changed: 'c',
				note: 'n'
			}),
			sceneSummary: buildSceneSummaryMessage('T', 'Body.'),
			chapterSummary: buildChapterSummaryMessage('T', ['a']),
			recap: buildRecapMessage(null),
			continuation: buildContinuationMessage('Once.'),
			coauthor: buildCoauthorMessage('b', null),
			draft: buildSceneDraftMessage({ brief: 'b', targetWords: 500 }),
			arc: buildArcMessage('Mara', [{ storyTitle: 'S', sceneTitle: 'T', text: 'x' }]),
			frame: renderFrame(frameScope, {
				writingRules: { language: NO_LANGUAGE, preferences: NO_PREFERENCES }
			})
		};
		for (const name of [
			'review',
			'copyedit',
			'pattern-pass',
			'write',
			'draft',
			'draft-chapter',
			'catchup',
			'rewrite',
			'continuity-review'
		]) {
			now[`mcp-${name}`] = buildMcpPrompt(name, ids, connection);
		}
		expect(now).toEqual(before);
	});

	// The Assistant preferences (#1344) follow the same rule: passed with
	// nothing set, every prompt is still the one in the fixture.
	it('are byte-identical with no Assistant preferences set', () => {
		const scene = { id: 'scene-1', title: 'The Gate' };
		const ps = { id: 's1', title: 'One', bodyMd: 'Text.' };
		const ids = {
			universeId: '11111111-1111-4111-8111-111111111111',
			storyId: '22222222-2222-4222-8222-222222222222',
			sceneId: '33333333-3333-4333-8333-333333333333',
			brief: 'b',
			chapter: 'One',
			passage: 'p',
			instruction: 'i'
		};
		const none = { language: NO_LANGUAGE, preferences: NO_PREFERENCES };
		const connection = { permissions: ['read', 'suggest'] as const, ...none };
		const review = (categories: Parameters<typeof buildReviewMessage>[2]) =>
			buildReviewMessage(
				scene,
				[],
				categories,
				false,
				false,
				IN_CONTEXT,
				NO_LANGUAGE,
				NO_PREFERENCES
			);
		const now: Record<string, string> = {
			review: review([]),
			copyedit: review(['mechanics', 'prose', 'lore']),
			patternSurvey: buildPatternSurveyMessage([ps], { scope: 'chapter', cap: 5, ...none }),
			patternBrief: buildPatternBrief({ storyId: 'st', cap: 5, ...none }),
			patternApply: buildPatternApplyMessage(
				{ name: 'E', description: 'd', sceneIds: ['s1'], examples: [] },
				ps,
				1000,
				NO_LANGUAGE,
				NO_PREFERENCES
			),
			coauthor: buildCoauthorMessage('b', null, none),
			draft: buildSceneDraftMessage({ brief: 'b', targetWords: 500, ...none }),
			frame: renderFrame(frameScope, { writingRules: none })
		};
		for (const name of [
			'review',
			'copyedit',
			'pattern-pass',
			'write',
			'rewrite',
			'draft',
			'draft-chapter',
			'continuity-review'
		]) {
			now[`mcp-${name}`] = buildMcpPrompt(name, ids, connection);
		}
		for (const [name, text] of Object.entries(now)) {
			expect(text, name).toBe((before as Record<string, string>)[name]);
		}
	});
});
