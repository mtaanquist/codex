// Why a reader reports a story, and why a moderator takes one down or removes
// it from Browse. One list for both, so the author is told the same reason a
// reader gave. Keys are stored; labels can change.
export const REPORT_REASONS = [
	{ key: 'copyright', label: "Copyright: it copies someone else's work" },
	{ key: 'illegal', label: 'Illegal content' },
	{ key: 'labels', label: 'Missing or wrong content warnings or adult flag' },
	{ key: 'spam', label: 'Spam' },
	{ key: 'other', label: 'Something else' }
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number]['key'];

// The reporter's optional comment.
export const MAX_REPORT_COMMENT = 500;

export function isReportReason(value: unknown): value is ReportReason {
	return REPORT_REASONS.some((reason) => reason.key === value);
}

export function reportReasonLabel(key: string | null | undefined): string {
	return REPORT_REASONS.find((reason) => reason.key === key)?.label ?? 'No reason given';
}
