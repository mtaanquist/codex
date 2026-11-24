import { describe, expect, it } from 'vitest';
import { canModerate } from './roles';

describe('canModerate', () => {
	it('lets admins and moderators through, nobody else', () => {
		expect(canModerate('admin')).toBe(true);
		expect(canModerate('moderator')).toBe(true);
		expect(canModerate('user')).toBe(false);
		expect(canModerate(null)).toBe(false);
		expect(canModerate(undefined)).toBe(false);
	});
});
