import { describe, it, expect } from 'vitest';
import { OUT_OF_DATE_SCENE_SUMMARY_NOTE, sceneSummaryToSend } from './summary-currency';

const updatedAt = new Date('2026-01-02T00:00:00Z');
const before = new Date('2026-01-01T00:00:00Z');

describe('sceneSummaryToSend', () => {
	it('sends the writer summary as it is, however old the scene edit', () => {
		expect(sceneSummaryToSend({ summaryMd: ' Mine. ', summaryGeneratedAt: null, updatedAt })).toBe(
			'Mine.'
		);
	});

	it('sends a current Assistant summary as it is', () => {
		expect(
			sceneSummaryToSend({ summaryMd: 'Auto.', summaryGeneratedAt: updatedAt, updatedAt })
		).toBe('Auto.');
	});

	it('labels an Assistant summary written before the scene last changed', () => {
		expect(sceneSummaryToSend({ summaryMd: 'Old.', summaryGeneratedAt: before, updatedAt })).toBe(
			`${OUT_OF_DATE_SCENE_SUMMARY_NOTE} Old.`
		);
	});

	it('gives no summary for a blank one', () => {
		expect(sceneSummaryToSend({ summaryMd: '  ', summaryGeneratedAt: before, updatedAt })).toBe(
			null
		);
		expect(sceneSummaryToSend({ summaryMd: null, summaryGeneratedAt: null, updatedAt })).toBe(null);
	});
});
