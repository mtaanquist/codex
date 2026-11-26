import { describe, expect, it } from 'vitest';
import {
	isReportReason,
	moderationEditionName,
	moderationRowName,
	reportReasonLabel
} from './report-reasons';

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

	it('names an edition by handle alone when its title is hidden', () => {
		expect(moderationRowName('ann', 'Tide')).toBe('@ann/Tide');
		expect(moderationRowName('ann', null)).toBe('@ann, a story that is not shared');
		expect(moderationEditionName('ann', 'Tide')).toBe('"Tide"');
		expect(moderationEditionName('ann', null)).toBe('a story by @ann that is not shared');
	});
});
