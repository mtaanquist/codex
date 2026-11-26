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

// How the moderation lists name an edition whose title the server left out,
// because the moderator may not open it (the story is private or in the
// trash). The row shows the handle with this label in place of the title.
export const NOT_SHARED_LABEL = 'a story that is not shared';

// An edition's name in a moderation list row: "@handle/title", or the handle
// with NOT_SHARED_LABEL when the title is hidden.
export function moderationRowName(handle: string | null, title: string | null): string {
	const owner = handle ? `@${handle}` : '';
	if (title === null) return owner ? `${owner}, ${NOT_SHARED_LABEL}` : NOT_SHARED_LABEL;
	return owner ? `${owner}/${title}` : title;
}

// The same edition named in a sentence, such as a confirm dialog or a button's
// label: the title in quotes, or "a story by @handle that is not shared".
export function moderationEditionName(handle: string | null, title: string | null): string {
	if (title !== null) return `"${title}"`;
	return handle ? `a story by @${handle} that is not shared` : NOT_SHARED_LABEL;
}
