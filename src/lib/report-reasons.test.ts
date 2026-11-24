import { describe, expect, it } from 'vitest';
import { isReportReason, reportReasonLabel } from './report-reasons';

describe('report reasons', () => {
	it('accepts only listed keys', () => {
		expect(isReportReason('spam')).toBe(true);
		expect(isReportReason('labels')).toBe(true);
		expect(isReportReason('rude')).toBe(false);
		expect(isReportReason(undefined)).toBe(false);
	});

	it('labels a key, and says so when there is none', () => {
		expect(reportReasonLabel('spam')).toBe('Spam');
		expect(reportReasonLabel(null)).toBe('No reason given');
		expect(reportReasonLabel('gone')).toBe('No reason given');
	});
});
