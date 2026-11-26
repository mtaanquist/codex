import { describe, expect, it } from 'vitest';
import { revisionNote, revisionTitle } from './revision-title';

describe('revisionTitle', () => {
	it('titles a checkpoint by its name and other rows by their reason', () => {
		expect(revisionTitle({ reason: 'checkpoint', label: 'Before the rewrite' })).toBe(
			'Before the rewrite'
		);
		expect(revisionTitle({ reason: 'suggestion', label: null })).toBe('Suggestion accepted');
		expect(revisionTitle({ reason: null, label: null })).toBe('Autosave');
	});

	it('shows any other label as a note', () => {
		const card = { reason: 'suggestion', label: 'Accepted in Writing Desk (app.example)' };
		expect(revisionTitle(card)).toBe('Suggestion accepted');
		expect(revisionNote(card)).toBe('Accepted in Writing Desk (app.example)');
		expect(revisionNote({ reason: 'checkpoint', label: 'Named' })).toBeNull();
	});
});
