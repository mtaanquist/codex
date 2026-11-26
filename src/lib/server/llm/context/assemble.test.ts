import { describe, it, expect } from 'vitest';
import {
	bodyTail,
	buildSystemMessage,
	estimateTokens,
	renderFrame,
	selectWithinBudget,
	type AssembledContext,
	type ContextTier
} from './assemble';
import { NO_LANGUAGE } from '../../../writing-languages';
import { NO_PREFERENCES, NOTES_BEGIN, NOTES_END } from '../../../assistant-preferences';

describe('estimateTokens', () => {
	it('approximates four characters per token', () => {
		expect(estimateTokens('')).toBe(0);
		expect(estimateTokens('abcd')).toBe(1);
		expect(estimateTokens('abcde')).toBe(2);
	});
});

describe('bodyTail', () => {
	it('returns the trimmed body whole when it is within the excerpt cap', () => {
		expect(bodyTail('  A short scene.  ')).toBe('A short scene.');
	});

	it('keeps the tail and marks the cut when the body is too long', () => {
		const body = 'HEAD' + 'x'.repeat(2000) + 'the very last words.';
		const tail = bodyTail(body);
		expect(tail.startsWith('[...] ')).toBe(true);
		expect(tail).toContain('the very last words.');
		// The opening is dropped: a continuation reads from where the prose left off.
		expect(tail).not.toContain('HEAD');
	});
});

describe('selectWithinBudget', () => {
	const tier = (name: string, chars: number): ContextTier => ({ name, text: 'x'.repeat(chars) });

	it('includes every tier when the budget is ample', () => {
		const result = selectWithinBudget([tier('a', 40), tier('b', 40)], 1000);
		expect(result.includedTiers).toEqual(['a', 'b']);
		expect(result.droppedTiers).toEqual([]);
	});

	it('always keeps the first tier even if it alone exceeds the budget', () => {
		// Frame is first and tiny in practice; this guards the "used > 0" rule.
		const result = selectWithinBudget([tier('frame', 400)], 1);
		expect(result.includedTiers).toEqual(['frame']);
	});

	it('drops a tier that does not fit but keeps a later, smaller one', () => {
		// 4 chars/token: frame=1 token, big=25 tokens, small=1 token. Budget 3.
		const result = selectWithinBudget([tier('frame', 4), tier('big', 100), tier('small', 4)], 3);
		expect(result.includedTiers).toEqual(['frame', 'small']);
		expect(result.droppedTiers).toEqual(['big']);
	});

	it('skips empty tiers silently', () => {
		const result = selectWithinBudget([tier('frame', 4), { name: 'empty', text: '   ' }], 1000);
		expect(result.includedTiers).toEqual(['frame']);
		expect(result.droppedTiers).toEqual([]);
	});

	it('mentions the scene tools only on tool-capable turns', () => {
		const context: AssembledContext = {
			kind: 'story',
			text: 'world context',
			estimatedTokens: 2,
			budgetTokens: 100,
			includedTiers: ['frame'],
			droppedTiers: [],
			establishedSetting: false,
			sources: { entities: [], scenes: [], lore: [] }
		};
		expect(buildSystemMessage(context).content).not.toContain('get_scene');
		const withTools = buildSystemMessage(context, { tools: true }).content;
		expect(withTools).toContain('get_scene');
		expect(withTools).toContain('list_scenes');
		expect(withTools).toContain('world context');
	});

	it('permits canon knowledge only for an established setting', () => {
		const context: AssembledContext = {
			kind: 'story',
			text: 'world context',
			estimatedTokens: 2,
			budgetTokens: 100,
			includedTiers: ['frame'],
			droppedTiers: [],
			establishedSetting: false,
			sources: { entities: [], scenes: [], lore: [] }
		};
		expect(buildSystemMessage(context).content).not.toContain('published canon');
		const established = buildSystemMessage({ ...context, establishedSetting: true }).content;
		expect(established).toContain('published canon');
		expect(established).toContain('overrides');
		// The tool hint still rides along on tool-capable turns.
		expect(
			buildSystemMessage({ ...context, establishedSetting: true }, { tools: true }).content
		).toContain('get_scene');
	});

	it('frames a universe scope with the cross-story preamble', () => {
		const context: AssembledContext = {
			kind: 'universe',
			text: 'universe context',
			estimatedTokens: 2,
			budgetTokens: 100,
			includedTiers: ['universe-frame'],
			droppedTiers: [],
			establishedSetting: false,
			sources: { entities: [], scenes: [], lore: [] }
		};
		const content = buildSystemMessage(context).content;
		expect(content).toContain('whole universe');
		expect(content).toContain('universe context');
		// The tool hint advertises cross-story reach on tool-capable turns.
		const withTools = buildSystemMessage(context, { tools: true }).content;
		expect(withTools).toContain('every story in the universe');
		// The established variant permits canon for a universe too.
		expect(buildSystemMessage({ ...context, establishedSetting: true }).content).toContain(
			'published canon'
		);
	});

	it('joins included tiers with a blank line', () => {
		const result = selectWithinBudget(
			[
				{ name: 'a', text: 'one' },
				{ name: 'b', text: 'two' }
			],
			1000
		);
		expect(result.text).toBe('one\n\ntwo');
	});
});

describe('renderFrame', () => {
	const scope = {
		storyId: 's',
		universeId: 'u',
		storyTitle: 'The Gate',
		storyBrief: null,
		storyDescription: null,
		storyStyleNotes: 'Literary.',
		universeName: 'Vael',
		universeDescription: null,
		universeEstablished: false
	};

	it('reads as without writing rules when none is set', () => {
		expect(
			renderFrame(scope, { writingRules: { language: NO_LANGUAGE, preferences: NO_PREFERENCES } })
		).toBe(renderFrame(scope));
	});

	it('states a set language and house style before the world', () => {
		const text = renderFrame(scope, {
			writingRules: {
				language: { language: 'en-GB', native: null },
				preferences: {
					...NO_PREFERENCES,
					houseStyle: { ...NO_PREFERENCES.houseStyle, quoteMarks: 'single', tense: 'past' }
				}
			}
		});
		const world = text.indexOf('## World: Vael');
		const language = text.indexOf('The story is written in');
		const style = text.indexOf('House style:');
		expect(language).toBeGreaterThan(text.indexOf('Literary.'));
		expect(style).toBeGreaterThan(language);
		expect(world).toBeGreaterThan(style);
		// The chat answers the writer in their own language; only prose it
		// writes keeps to the story's.
		expect(text).toContain(
			'Write prose, passages and suggested edits in British English, keeping to British English spelling and usage. Answer the writer in the language they write to you in.'
		);
		expect(text).not.toContain('Write in British English,');
		expect(text).toContain('single quotation marks for dialogue');
		expect(text).toContain('past tense');
		expect(text).toContain('Keep to it.');
		expect(text).toContain(
			"The tense applies to the narration only: do not flag dialogue, a character's quoted thoughts, or quoted text for it."
		);
	});

	it('states the habits left alone and the fenced notes after the house style', () => {
		const text = renderFrame(scope, {
			writingRules: {
				language: NO_LANGUAGE,
				preferences: {
					...NO_PREFERENCES,
					houseStyle: { ...NO_PREFERENCES.houseStyle, tense: 'past' },
					leaveAlone: ['filterVerbs'],
					notes: 'I like long sentences.'
				}
			}
		});
		const style = text.indexOf('House style:');
		const leave = text.indexOf('unless the writer asks about them');
		const begin = text.indexOf(NOTES_BEGIN);
		const note = text.indexOf('I like long sentences.');
		const end = text.indexOf(NOTES_END);
		expect(leave).toBeGreaterThan(style);
		// The chat may still discuss them when the writer asks.
		expect(text).not.toContain('Leave them alone');
		expect(text).toContain('filter verbs');
		expect(begin).toBeGreaterThan(leave);
		expect(note).toBeGreaterThan(begin);
		expect(end).toBeGreaterThan(note);
		expect(text.indexOf('## World: Vael')).toBeGreaterThan(end);
	});

	it('states the notes and habits left alone with no house style set', () => {
		const text = renderFrame(scope, {
			writingRules: {
				language: NO_LANGUAGE,
				preferences: { ...NO_PREFERENCES, leaveAlone: ['epithets'], notes: 'Keep it terse.' }
			}
		});
		expect(text).not.toContain('House style');
		expect(text).toContain('unless the writer asks about them');
		expect(text).toContain('Keep it terse.');
	});
});
