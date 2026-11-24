// Account roles. A moderator handles the public side (published editions,
// reports, Browse listings, tags) but nothing that runs the instance.
export const ROLES = ['admin', 'moderator', 'user'] as const;
export type Role = (typeof ROLES)[number];

export function canModerate(role: Role | undefined | null): boolean {
	return role === 'admin' || role === 'moderator';
}
