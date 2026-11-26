import { and, eq, isNull } from 'drizzle-orm';
import { publications } from './db/schema.ts';

// The editions the Published page lists and the admin overview counts: each
// story's current edition, unless a moderator took it down. One an account
// deletion hid is included, so it can still be taken down.
export function currentNotTakenDown() {
	return and(eq(publications.isCurrent, true), isNull(publications.removedReason));
}
