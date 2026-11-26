import { and, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { publicationReports, publications, stories, users } from './db/schema.ts';
import { storyIsLive } from './universe-scope.ts';

// The editions the Published page lists and the admin overview counts: each
// story's current edition, unless a moderator took it down. One an account
// deletion hid is included, so it can still be taken down.
export function currentNotTakenDown(
	edition: { isCurrent: AnyPgColumn; removedReason: AnyPgColumn } = publications
) {
	return and(eq(edition.isCurrent, true), isNull(edition.removedReason));
}

// Whether readers can open an edition at its public address right now: the
// same checks as publicEdition, so a link it gates never 404s. The query must
// join stories on the edition's story and users on the edition's owner.
export function readersCanOpen() {
	return sql<boolean>`(${stories.visibility} <> 'private' and ${storyIsLive()} and ${stories.ownerId} = ${publications.ownerId} and ${publications.isCurrent} and ${publications.removedAt} is null and ${users.suspendedAt} is null)`;
}

const NEWER = 'newer';
const newer = alias(publications, NEWER);

// The story's newer edition a takedown of the outer query's edition also puts
// down: its current one, when that is another edition and not taken down
// (currentNotTakenDown, so one an account deletion hid counts). The queue
// shows it and the takedown checks the id the queue posted back against it,
// so the two must agree. The query must select from publications.
function newerEditionOf(column: SQL) {
	return sql`(select ${column} from ${publications} as ${sql.identifier(NEWER)} where ${and(
		eq(newer.storyId, publications.storyId),
		currentNotTakenDown(newer),
		ne(newer.id, publications.id)
	)} limit 1)`;
}

export function newerEditionId() {
	return newerEditionOf(sql`${newer.id}`) as SQL<string | null>;
}

// What readers see of that newer edition: 'up' while they can open it (the
// checks publicEdition makes), 'hidden' while the writer's account deletion
// hides it, 'closed' while they cannot open it anyway (the story is private or
// in the trash, or the writer is suspended), else null. The query must join
// stories on the outer edition's story.
export function newerEditionState() {
	return newerEditionOf(
		sql`case when ${newer.removedAt} is not null then 'hidden' when ${stories.visibility} <> 'private' and ${storyIsLive()} and ${stories.ownerId} = ${newer.ownerId} and exists (select 1 from ${users} o where o.id = ${newer.ownerId} and o.suspended_at is null) then 'up' else 'closed' end`
	) as SQL<'up' | 'hidden' | 'closed' | null>;
}

// Whether a moderator may read an edition's text on its own page: it is the
// current edition of a story still shared (not private, not in the trash), or
// it has a report that is open, or one closed by a takedown that still holds
// on the story. A takedown alone does not unlock an edition, so one it put
// down only because it was the story's current edition (of a story the author
// made private) stays unread, and once the takedown is lifted (a mistake) its
// reports unlock nothing. A dismissed report does not unlock it either. The
// query must join stories on the edition's story.
export function moderatorMayRead() {
	// The takedown that closed a report set the report's resolved_at and the
	// editions' taken_down_at to the same now() in one transaction, so it still
	// holds while an edition of the story is down with that time. A restore
	// clears taken_down_at, and a later takedown sets a later time. A takedown
	// from before migration 0133 has no taken_down_at and does not hold here.
	// A takedown sets taken_down_at and closes its reports at one now(), so
	// each takedown and restore must run in its own top-level transaction.
	const takedownHolds = sql`exists (select 1 from ${publications} d where d.story_id = ${publications.storyId} and d.removed_reason is not null and d.taken_down_at = ${publicationReports.resolvedAt})`;
	return sql<boolean>`((${publications.isCurrent} and ${stories.visibility} <> 'private' and ${storyIsLive()}) or exists (select 1 from ${publicationReports} where ${publicationReports.publicationId} = ${publications.id} and (${publicationReports.resolvedAt} is null or (${publicationReports.resolution} = 'taken_down' and ${takedownHolds}))))`;
}

// The edition's title, or null when moderatorMayRead does not let the
// moderator open the edition, so the moderation lists do not show (or match
// in a search) the title of a story its writer never shared or took back.
export function titleModeratorMayRead() {
	return sql<string | null>`case when ${moderatorMayRead()} then ${publications.title} end`;
}
