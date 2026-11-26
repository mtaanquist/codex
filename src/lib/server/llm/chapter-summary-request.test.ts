import { describe, expect, it } from 'vitest';
import { chapterSummaryRequest } from './chapter-summary-request.ts';

describe('chapterSummaryRequest', () => {
	const scenes = [
		{
			summaryMd: 'They reach the gate.',
			summaryGeneratedAt: null,
			updatedAt: new Date('2026-01-01T00:00:00Z')
		}
	];

	it('sends the length the writer chose without changing the fingerprint', () => {
		const short = chapterSummaryRequest('One', scenes)!;
		const detailed = chapterSummaryRequest('One', scenes, 'detailed')!;
		expect(short.messages[0].content).toContain('in one or two sentences');
		expect(detailed.messages[0].content).toContain('three to five sentences');
		expect(detailed.input).toBe(short.input);
	});
});
