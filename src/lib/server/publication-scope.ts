import { and, eq, isNull, sql } from 'drizzle-orm';
import { publications, stories, users } from './db/schema.ts';
import { storyIsLive } from './universe-scope.ts';

// The editions the Published page lists and the admin overview counts: each
// story's current edition, unless a moderator took it down. One an account
// deletion hid is included, so it can still be taken down.
export function currentNotTakenDown() {
	return and(eq(publications.isCurrent, true), isNull(publications.removedReason));
}

// Whether readers can open an edition at its public address right now: the
// same checks as publicEdition, so a link it gates never 404s. The query must
// join stories on the edition's story and users on the edition's owner.
export function readersCanOpen() {
	return sql<boolean>`(${stories.visibility} <> 'private' and ${storyIsLive()} and ${stories.ownerId} = ${publications.ownerId} and ${publications.isCurrent} and ${publications.removedAt} is null and ${users.suspendedAt} is null)`;
}
