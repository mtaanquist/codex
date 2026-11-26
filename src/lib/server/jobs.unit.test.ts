import { describe, it, expect, vi, beforeEach } from 'vitest';

// The send options are the contract under test, so pg-boss is stood in for and
// the calls are read back off it.
const sends: { queue: string; data: unknown; options: Record<string, unknown> }[] = [];

vi.mock('pg-boss', () => ({
	PgBoss: class {
		on() {}
		async start() {}
		async createQueue() {}
		async send(queue: string, data: unknown, options: Record<string, unknown> = {}) {
			sends.push({ queue, data, options });
			return 'job-id';
		}
	}
}));

const { queueAssistantReview, queueAssistantSummaries, reviewJobState, ASSISTANT_REVIEW_QUEUE } =
	await import('./jobs');
const { ASSISTANT_JOB_EXPIRY_SECONDS } = await import('./queues');
const { reviewScopeKey, reviewSettingsKey, storyReviewSettingsKey } = await import('./review-runs');
const { NO_PREFERENCES, effectivePreferences } = await import('../assistant-preferences');
const { NO_LANGUAGE } = await import('../writing-languages');

beforeEach(() => {
	sends.length = 0;
});

describe('Assistant job send options (long runs)', () => {
	it('gives a queued review hours to run rather than the 15-minute default', async () => {
		await queueAssistantReview({ userId: 'u', storyId: 's', categories: [] });

		expect(sends[0].queue).toBe(ASSISTANT_REVIEW_QUEUE);
		expect(sends[0].options.expireInSeconds).toBe(ASSISTANT_JOB_EXPIRY_SECONDS);
		expect(ASSISTANT_JOB_EXPIRY_SECONDS).toBeGreaterThanOrEqual(3600);
	});

	it('leaves a retry limit in place so a crashed run is picked up again', async () => {
		await queueAssistantReview({ userId: 'u', storyId: 's', categories: [] });
		await queueAssistantSummaries({ userId: 'u', storyId: 's' });

		for (const send of sends) expect(send.options.retryLimit).toBeGreaterThan(0);
	});

	it('gives the summaries job the same expiry', async () => {
		await queueAssistantSummaries({ userId: 'u', storyId: 's' });

		expect(sends[0].options.expireInSeconds).toBe(ASSISTANT_JOB_EXPIRY_SECONDS);
	});

	it('holds one unfinished review per scope, keyed the way a run records it', async () => {
		await queueAssistantReview({
			userId: 'u',
			storyId: 's',
			chapterId: 'c',
			categories: ['prose']
		});

		expect(sends[0].options.singletonKey).toBe(
			reviewScopeKey({ storyId: 's', chapterId: 'c', categories: ['prose'] })
		);
	});
});

describe('reviewScopeKey', () => {
	it('gives a run with a pattern pass its own scope, and leaves the plain key as it was', () => {
		const plain = reviewScopeKey({ storyId: 's', categories: [] });
		expect(plain).toBe('full:s:general');
		expect(reviewScopeKey({ storyId: 's', categories: [], patterns: 'chapter' })).toBe(
			`${plain}:patterns-chapter`
		);
	});
});

describe('reviewJobState', () => {
	it('calls a forgotten job with unfinished progress stale, not done', () => {
		expect(reviewJobState('done', 'scenes')).toBe('stale');
		expect(reviewJobState('done', 'summaries')).toBe('stale');
	});

	it('leaves a finished run and a live one alone', () => {
		expect(reviewJobState('done', 'done')).toBe('done');
		expect(reviewJobState('running', 'scenes')).toBe('running');
		expect(reviewJobState('failed', 'scenes')).toBe('failed');
	});
});

describe('reviewScopeKey', () => {
	it('names the mode and the target', () => {
		expect(reviewScopeKey({ storyId: 's' })).toBe('full:s:general');
		expect(reviewScopeKey({ storyId: 's', chapterId: 'c', categories: ['prose'] })).toBe(
			'full:s:c:prose'
		);
		expect(reviewScopeKey({ storyId: 's', mode: 'continuity' })).toBe('continuity:s');
		expect(reviewScopeKey({ universeId: 'u', mode: 'continuity' })).toBe('continuity:universe:u');
	});

	it('tells copyedits with different categories apart, whatever order they arrive in', () => {
		const prose = reviewScopeKey({ storyId: 's', categories: ['prose'] });
		expect(prose).not.toBe(reviewScopeKey({ storyId: 's', categories: ['mechanics'] }));
		expect(prose).not.toBe(reviewScopeKey({ storyId: 's', categories: [] }));
		expect(reviewScopeKey({ storyId: 's', categories: ['lore', 'mechanics', 'lore'] })).toBe(
			reviewScopeKey({ storyId: 's', categories: ['mechanics', 'lore'] })
		);
		// The continuity pass ignores categories, so they do not split its key.
		expect(reviewScopeKey({ storyId: 's', mode: 'continuity', categories: ['prose'] })).toBe(
			'continuity:s'
		);
	});
});

describe('reviewSettingsKey', () => {
	const notes = { ...NO_PREFERENCES, notes: 'Splices on purpose.' };

	it('changes with the language or the preferences', () => {
		const plain = reviewSettingsKey(NO_LANGUAGE, NO_PREFERENCES, true);
		expect(plain).toBe(reviewSettingsKey(NO_LANGUAGE, { ...NO_PREFERENCES }, true));
		expect(reviewSettingsKey(NO_LANGUAGE, notes, true)).not.toBe(plain);
		expect(reviewSettingsKey({ language: 'da', native: null }, NO_PREFERENCES, true)).not.toBe(
			plain
		);
		expect(
			reviewSettingsKey(
				NO_LANGUAGE,
				{
					...NO_PREFERENCES,
					houseStyle: { ...NO_PREFERENCES.houseStyle, tense: 'past' }
				},
				true
			)
		).not.toBe(plain);
	});

	it("changes when a story turns its universe's notes off", () => {
		const universe = { preferences: {}, notes: 'Fragments are on purpose.' };
		const using = effectivePreferences({ preferences: {}, notes: null }, universe);
		const off = effectivePreferences(
			{ preferences: { useUniverseNotes: 'no' }, notes: null },
			universe
		);
		expect(reviewSettingsKey(NO_LANGUAGE, using, true)).not.toBe(
			reviewSettingsKey(NO_LANGUAGE, off, true)
		);
	});

	it('changes with the feedback, reasons and content limits, even for a pass that skips wording', () => {
		const plain = reviewSettingsKey(NO_LANGUAGE, null, false, null, NO_PREFERENCES);
		expect(reviewSettingsKey(NO_LANGUAGE, null, false)).toBe(plain);
		const limits = (limit: 'avoid' | 'write') => ({
			...NO_PREFERENCES,
			contentLimits: [{ slug: 'gore', name: 'Gore', limit }]
		});
		const keys = [
			plain,
			reviewSettingsKey(NO_LANGUAGE, null, false, null, {
				...NO_PREFERENCES,
				feedback: 'thorough'
			}),
			reviewSettingsKey(NO_LANGUAGE, null, false, null, {
				...NO_PREFERENCES,
				editReasons: 'never'
			}),
			reviewSettingsKey(NO_LANGUAGE, null, false, null, limits('avoid')),
			reviewSettingsKey(NO_LANGUAGE, null, false, null, limits('write'))
		];
		expect(new Set(keys).size).toBe(keys.length);
		// The order the limits were listed in does not count.
		const two = (a: string, b: string) => ({
			...NO_PREFERENCES,
			contentLimits: [
				{ slug: a.toLowerCase(), name: a, limit: 'avoid' as const },
				{ slug: b.toLowerCase(), name: b, limit: 'avoid' as const }
			]
		});
		expect(reviewSettingsKey(NO_LANGUAGE, null, false, null, two('Gore', 'War'))).toBe(
			reviewSettingsKey(NO_LANGUAGE, null, false, null, two('War', 'Gore'))
		);
		// Keyed by slug: renaming a warning keeps the key, another warning does not.
		const named = (slug: string, name: string) => ({
			...NO_PREFERENCES,
			contentLimits: [{ slug, name, limit: 'avoid' as const }]
		});
		expect(reviewSettingsKey(NO_LANGUAGE, null, false, null, named('gore', 'Gore'))).toBe(
			reviewSettingsKey(NO_LANGUAGE, null, false, null, named('gore', 'Graphic violence'))
		);
		expect(reviewSettingsKey(NO_LANGUAGE, null, false, null, named('gore', 'Gore'))).not.toBe(
			reviewSettingsKey(NO_LANGUAGE, null, false, null, named('war', 'Gore'))
		);
	});

	it('treats reasons "when not obvious" like not set', () => {
		expect(
			reviewSettingsKey(NO_LANGUAGE, null, false, null, {
				...NO_PREFERENCES,
				editReasons: 'unobvious'
			})
		).toBe(reviewSettingsKey(NO_LANGUAGE, null, false, null, NO_PREFERENCES));
	});

	it('keys the house style, habits and notes for a lore review with a pattern pass', () => {
		const settings = { language: NO_LANGUAGE, preferences: NO_PREFERENCES, styleNotes: null };
		const changed = [
			{ ...settings, preferences: notes },
			{ ...settings, preferences: { ...NO_PREFERENCES, leaveAlone: ['epithets' as const] } },
			{
				...settings,
				preferences: {
					...NO_PREFERENCES,
					houseStyle: { ...NO_PREFERENCES.houseStyle, tense: 'past' as const }
				}
			},
			{ ...settings, styleNotes: 'Hardboiled noir.' }
		];
		const plain = storyReviewSettingsKey(settings, ['lore'], 'book');
		for (const other of changed) {
			expect(storyReviewSettingsKey(other, ['lore'], 'book')).not.toBe(plain);
			// Without the pattern pass a lore review does not read them.
			expect(storyReviewSettingsKey(other, ['lore'], undefined)).toBe(
				storyReviewSettingsKey(settings, ['lore'], undefined)
			);
		}
	});

	it('changes with the style notes, which the prose is judged against', () => {
		const plain = reviewSettingsKey(NO_LANGUAGE, NO_PREFERENCES, true);
		const noir = reviewSettingsKey(NO_LANGUAGE, NO_PREFERENCES, true, 'Hardboiled noir.');
		expect(noir).not.toBe(plain);
		expect(reviewSettingsKey(NO_LANGUAGE, NO_PREFERENCES, true, 'Cosy mystery.')).not.toBe(noir);
		// No notes keys as it did before style notes were part of the key.
		expect(reviewSettingsKey(NO_LANGUAGE, NO_PREFERENCES, true, null)).toBe(plain);
		expect(reviewSettingsKey(NO_LANGUAGE, NO_PREFERENCES, true, '  ')).toBe(plain);
	});

	it('changes with the native language only where the prompts hint at it', () => {
		const english = { language: 'en-GB', native: 'da' } as const;
		const swedish = { language: 'en-GB', native: 'sv' } as const;
		// A pass that never hints at it: a lore-only or general review.
		expect(reviewSettingsKey(english, null, false)).toBe(reviewSettingsKey(swedish, null, false));
		// A pass that does.
		expect(reviewSettingsKey(english, NO_PREFERENCES, true)).not.toBe(
			reviewSettingsKey(swedish, NO_PREFERENCES, true)
		);
		// No hint without a story language to compare, or when they match.
		expect(reviewSettingsKey({ language: null, native: 'da' }, NO_PREFERENCES, true)).toBe(
			reviewSettingsKey(NO_LANGUAGE, NO_PREFERENCES, true)
		);
		expect(reviewSettingsKey({ language: 'en-GB', native: 'en-US' }, NO_PREFERENCES, true)).toBe(
			reviewSettingsKey({ language: 'en-GB', native: null }, NO_PREFERENCES, true)
		);
	});

	it('ignores the order the habits were left alone in', () => {
		expect(
			reviewSettingsKey(
				NO_LANGUAGE,
				{
					...NO_PREFERENCES,
					leaveAlone: ['epithets', 'commaSplices']
				},
				true
			)
		).toBe(
			reviewSettingsKey(
				NO_LANGUAGE,
				{
					...NO_PREFERENCES,
					leaveAlone: ['commaSplices', 'epithets']
				},
				true
			)
		);
	});
});
