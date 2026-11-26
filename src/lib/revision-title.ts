// The title a revision shows in a history list. A checkpoint's name is its
// title; any other label (where a draft was kept from, which app accepted a
// suggestion) is a note shown under it.
const TITLE: Record<string, string> = {
	checkpoint: 'Checkpoint',
	restore: 'Restored',
	suggestion: 'Suggestion accepted',
	autosave: 'Autosave'
};

export function revisionTitle(row: { reason: string | null; label: string | null }): string {
	if (row.reason === 'checkpoint' && row.label) return row.label;
	return TITLE[row.reason ?? 'autosave'] || 'Autosave';
}

export function revisionNote(row: { reason: string | null; label: string | null }): string | null {
	return row.label && row.reason !== 'checkpoint' ? row.label : null;
}
