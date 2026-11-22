import { describe, expect, it } from 'vitest';
import { clearedSuggestions } from './review-clear';

const edit = (id: string, status: string, followsId: string | null = null) => ({
	id,
	status,
	followsId
});
const decided = (s: { status: string }) => s.status !== 'pending';

describe('clearedSuggestions', () => {
	it('keeps the chain of edits a waiting follow-up builds on', () => {
		const edits = [
			edit('a', 'accepted'),
			edit('b', 'accepted', 'a'),
			edit('c', 'pending', 'b'),
			edit('d', 'rejected'),
			edit('e', 'pending')
		];
		expect([...clearedSuggestions(edits, decided)]).toEqual(['d']);
	});

	it('takes the whole chain once its follow-up is decided', () => {
		const edits = [edit('b', 'accepted', 'a'), edit('a', 'accepted'), edit('c', 'rejected', 'b')];
		expect([...clearedSuggestions(edits, decided)].sort()).toEqual(['a', 'b', 'c']);
	});

	it('copes with a follow-up whose original is not listed', () => {
		expect([...clearedSuggestions([edit('c', 'pending', 'gone')], decided)]).toEqual([]);
	});
});
