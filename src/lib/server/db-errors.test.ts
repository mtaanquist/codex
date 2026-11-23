import { describe, it, expect } from 'vitest';
import { isUniqueViolation } from './db-errors';

const clash = (constraint: string) => ({ cause: { code: '23505', constraint } });

describe('isUniqueViolation', () => {
	it('matches any unique violation without a constraint name', () => {
		expect(isUniqueViolation(clash('stories_owner_slug_idx'))).toBe(true);
		expect(isUniqueViolation({ cause: { code: '23503' } })).toBe(false);
		expect(isUniqueViolation(new Error('plain'))).toBe(false);
	});

	it('matches only the named constraint when one is given', () => {
		expect(isUniqueViolation(clash('stories_owner_slug_idx'), 'stories_owner_slug_idx')).toBe(true);
		expect(isUniqueViolation(clash('character_story_notes_unique'), 'stories_owner_slug_idx')).toBe(
			false
		);
	});
});
