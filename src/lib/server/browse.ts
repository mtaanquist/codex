import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { publicationReports, publications, stories, tags } from './db/schema.ts';
import { pattern } from './search.ts';
import { tagsForStories, type ListKind, type TagKind } from './tags.ts';
import { storyCoverColor } from '../entity-color.ts';
import { authorName } from '../author-name.ts';
import { slugAddress } from '../slug.ts';
import { BROWSE_PAGE_SIZE, encodeCursor, type BrowseQuery } from '../browse.ts';
import type { ReportReason } from '../report-reasons.ts';
import { microsText } from './db-clock.ts';
import { moderatorMayRead } from './publication-scope.ts';

// The public Browse page: current editions of public stories their authors
// listed, across the whole instance. Unlisted and private stories never show.

const MAX_MERGE_DEPTH = 8;

// The condition every listed story meets. Expects publications p, stories s
// and users u in the FROM. The owner check is wrapped in coalesce (a no-op,
// both columns are not null) because as a plain join equality the planner
// takes it as independent of p.story_id = s.id, guesses a few dozen rows,
// and sorts the whole set instead of reading publications_browse in order.
export const listedInBrowseCondition = sql`
	p.is_current and p.removed_at is null
	and coalesce(s.owner_id = p.owner_id, false)
	and s.deleted_at is null
	and exists (select 1 from universes lu where lu.id = s.universe_id and lu.deleted_at is null)
	and s.visibility = 'public' and s.listed_in_browse and s.browse_blocked_at is null
	and u.suspended_at is null and u.deletion_scheduled_at is null and not u.hidden_from_browse
`;

// An edition's publish time in whole microseconds, for the page cursor.
const MICROS = sql.raw('(extract(epoch from p.published_at) * 1000000)::bigint');

// ids and names cover the entry and every entry merged into it; names match
// the warnings an edition froze by name at publish.
type FilterTag = { name: string; slug: string; ids: string[]; names: string[] };

// A filter's tag by slug, followed through merges to the entry that survives,
// with every entry merged into it, so a story tagged with an old spelling
// still matches. Null when there is no such entry or it was removed.
export async function resolveFilterTag(
	db: Database,
	kind: TagKind,
	slug: string
): Promise<FilterTag | null> {
	let [tag] = await db
		.select()
		.from(tags)
		.where(and(eq(tags.kind, kind), eq(tags.slug, slug)));
	for (let depth = 0; tag?.mergedIntoId && depth < MAX_MERGE_DEPTH; depth++) {
		[tag] = await db.select().from(tags).where(eq(tags.id, tag.mergedIntoId));
	}
	if (!tag || tag.removedAt || tag.mergedIntoId) return null;
	const closure = await db.execute(sql`
		with recursive closure as (
			select id, name, 0 as depth from tags where id = ${tag.id}
			union all
			select t.id, t.name, c.depth + 1 from tags t join closure c on t.merged_into_id = c.id
			where c.depth < ${MAX_MERGE_DEPTH}
		)
		select distinct id, name from closure
	`);
	const rows = closure.rows as { id: string; name: string }[];
	const ids = rows.map((row) => row.id);
	const names = [...new Set(rows.map((row) => row.name))];
	// A free-form tag only counts once a listed story carries it, so a tag
	// that lives on private stories alone is not revealed by its name.
	if (kind === 'tag') {
		const used = await db.execute(sql`
			select 1 from story_tags st
			join stories s on s.id = st.story_id
			join publications p on p.story_id = s.id
			join users u on u.id = p.owner_id
			where st.tag_id in (${sql.join(
				ids.map((id) => sql`${id}::uuid`),
				sql`, `
			)}) and ${listedInBrowseCondition}
			limit 1
		`);
		if (used.rows.length === 0) return null;
	}
	return { name: tag.name, slug: tag.slug, ids, names };
}

function hasAny(ids: string[]): SQL {
	return sql`exists (select 1 from story_tags st where st.story_id = s.id and st.tag_id in (${sql.join(
		ids.map((id) => sql`${id}::uuid`),
		sql`, `
	)}))`;
}

export type BrowseFilters = {
	genre: FilterTag | null;
	fandom: FilterTag | null;
	tag: FilterTag | null;
	hide: FilterTag[];
};

// The tags a query names, resolved. A filter naming nothing that exists
// comes back null, and the page then shows no stories for it.
export async function resolveFilters(db: Database, query: BrowseQuery) {
	const one = (kind: ListKind | 'tag', slug: string | null) =>
		slug ? resolveFilterTag(db, kind, slug) : Promise.resolve(null);
	const hide = await Promise.all(query.hide.map((slug) => resolveFilterTag(db, 'warning', slug)));
	return {
		genre: await one('genre', query.genre),
		fandom: await one('fandom', query.fandom),
		tag: await one('tag', query.tag),
		hide: hide.filter((tag): tag is FilterTag => tag !== null)
	};
}

export type BrowseBook = {
	storyId: string;
	slug: string;
	title: string;
	descriptionMd: string | null;
	isAdult: boolean;
	publishedAt: Date;
	coverAssetId: string | null;
	coverColor: string;
	genres: string[];
	handle: string;
	byline: string;
	universe: { name: string; slug: string } | null;
};

// The author's public name, as authorName picks it: the pen name when set,
// so a search never ties a pen name to the account's own name.
const shownName = sql`coalesce(nullif(trim(u.pen_name), ''), u.display_name)`;

// The genre, fandom, tag, hidden warning and adult conditions a query sets,
// shared by the stories and the Writers list so the two agree. Null when a
// filter names a missing or removed entry, which matches nothing. Expects
// publications p, stories s and universes un in the FROM.
function filterConditions(query: BrowseQuery, filters: BrowseFilters): SQL[] | null {
	if ((query.genre && !filters.genre) || (query.fandom && !filters.fandom)) return null;
	if (query.tag && !filters.tag) return null;

	const conditions: SQL[] = [];
	if (!query.adult) conditions.push(sql`not p.is_adult`);
	for (const tag of [filters.genre, filters.tag]) {
		if (tag) conditions.push(hasAny(tag.ids));
	}
	if (filters.fandom) {
		// The story's own fandoms, or the one its universe is linked to.
		conditions.push(
			sql`(${hasAny(filters.fandom.ids)} or un.fandom_id in (${sql.join(
				filters.fandom.ids.map((id) => sql`${id}::uuid`),
				sql`, `
			)}))`
		);
	}
	if (filters.hide.length > 0) {
		// Hidden if the story carries the warning now or its edition did at
		// publish, so a reader is not shown a warning they asked to avoid. The
		// edition froze the warnings' ids, which survive a rename and include
		// entries since merged into the warning. Editions from before ids were
		// frozen carry names alone and match by name.
		const ids = filters.hide.flatMap((tag) => tag.ids);
		conditions.push(sql`not ${hasAny(ids)}`);
		conditions.push(
			sql`not (p.content_warning_ids && array[${sql.join(
				ids.map((id) => sql`${id}`),
				sql`, `
			)}]::uuid[])`
		);
		conditions.push(
			sql`not (cardinality(p.content_warning_ids) = 0 and p.content_warnings && array[${sql.join(
				filters.hide.flatMap((tag) => tag.names.map((name) => sql`${name}`)),
				sql`, `
			)}]::text[])`
		);
	}
	return conditions;
}

// The columns and joins a shelf card needs, shared by Browse and the similar
// stories on a reading page. Expects the listedInBrowseCondition aliases.
const BOOK_COLUMNS = sql`p.id as publication_id, p.story_id, s.slug, p.title, p.description_md, p.is_adult,
	p.published_at, s.cover_asset_id, s.cover_color, p.handle, p.author,
	u.pen_name, u.display_name, un.id as universe_id, un.name as universe_name, un.slug as universe_slug,
	un.standalone`;
const BOOK_FROM = sql`from publications p
	join stories s on s.id = p.story_id
	join users u on u.id = p.owner_id
	join universes un on un.id = s.universe_id`;

type BookRow = {
	publication_id: string;
	story_id: string;
	slug: string;
	title: string;
	description_md: string | null;
	is_adult: boolean;
	published_at: string | Date;
	cover_asset_id: string | null;
	cover_color: string | null;
	handle: string;
	author: string | null;
	pen_name: string | null;
	display_name: string | null;
	universe_id: string;
	universe_name: string;
	universe_slug: string;
	standalone: boolean;
};

async function toBooks(db: Database, rows: BookRow[]): Promise<BrowseBook[]> {
	const labels = await tagsForStories(
		db,
		rows.map((row) => row.story_id)
	);
	return rows.map((row) => ({
		storyId: row.story_id,
		slug: row.slug,
		title: row.title,
		descriptionMd: row.description_md,
		isAdult: row.is_adult,
		publishedAt: new Date(row.published_at),
		coverAssetId: row.cover_asset_id,
		coverColor: storyCoverColor({ id: row.story_id, coverColor: row.cover_color }),
		genres: (labels.get(row.story_id) ?? [])
			.filter((tag) => tag.kind === 'genre')
			.map((tag) => tag.name),
		handle: row.handle,
		byline:
			row.author?.trim() ||
			authorName({ penName: row.pen_name, displayName: row.display_name }) ||
			`@${row.handle}`,
		universe: row.standalone
			? null
			: {
					name: row.universe_name,
					slug: slugAddress({ id: row.universe_id, slug: row.universe_slug })
				}
	}));
}

export async function browseStories(
	db: Database,
	query: BrowseQuery,
	filters: BrowseFilters
): Promise<{ books: BrowseBook[]; next: string | null }> {
	const filtered = filterConditions(query, filters);
	if (!filtered) return { books: [], next: null };

	const conditions: SQL[] = [listedInBrowseCondition, ...filtered];
	if (query.q) {
		const like = pattern(query.q);
		conditions.push(sql`(
			p.title ilike ${like} or p.author ilike ${like} or p.description_md ilike ${like}
			or ${shownName} ilike ${like}
			or (not un.standalone and un.name ilike ${like})
		)`);
	}
	if (query.after) {
		// Compared as a timestamp, not as MICROS, so the publications_browse
		// index serves the cursor as well as the order.
		conditions.push(
			sql`(p.published_at, p.id) < (timestamptz 'epoch' + ${query.after.micros}::bigint * interval '1 microsecond', ${query.after.id}::uuid)`
		);
	}

	const result = await db.execute(sql`
		select ${BOOK_COLUMNS}, ${MICROS}::text as published_micros
		${BOOK_FROM}
		where ${sql.join(conditions, sql` and `)}
		order by p.published_at desc, p.id desc
		limit ${BROWSE_PAGE_SIZE + 1}
	`);
	const rows = result.rows as (BookRow & { published_micros: string })[];
	const page = rows.slice(0, BROWSE_PAGE_SIZE);
	const books = await toBooks(db, page);
	const last = page[page.length - 1];
	return {
		books,
		next:
			rows.length > BROWSE_PAGE_SIZE && last
				? encodeCursor(last.published_micros, last.publication_id)
				: null
	};
}

export const SIMILAR_LIMIT = 6;
// A shared free-form tag weighs ln(listed stories / listed stories with the
// tag), so a rare tag counts for more. A shared genre adds a small fixed
// weight; a story has at most MAX_GENRES of them, and those alone stay under
// the minimum, so a match needs at least one tag that is not on most stories.
// Fandoms and content warnings do not count.
const GENRE_WEIGHT = 0.15;
const MIN_SIMILAR_SCORE = 0.5;

// Listed stories that share the story's genres and free-form tags, best match
// first. Adult work only when the reader confirmed they may see it. The story
// itself may be unlisted; only the matches have to be in Browse.
export async function similarStories(
	db: Database,
	storyId: string,
	{ adult }: { adult: boolean }
): Promise<BrowseBook[]> {
	const result = await db.execute(sql`
		with source as (
			-- The story's labels, each followed through a merge to its survivor
			-- (a merge keeps chains one step deep).
			select distinct t.id, t.kind
			from story_tags st
			join tags start on start.id = st.tag_id
			join tags t on t.id = coalesce(start.merged_into_id, start.id)
			where st.story_id = ${storyId}::uuid and t.kind in ('tag', 'genre')
				and t.removed_at is null and t.merged_into_id is null
		), listed as (
			select p.story_id
			from publications p
			join stories s on s.id = p.story_id
			join users u on u.id = p.owner_id
			where ${listedInBrowseCondition}
		), hits as (
			-- The listed stories carrying each of those labels, by any entry
			-- merged into it too.
			select distinct l.story_id, src.id, src.kind
			from source src
			join tags t on t.id = src.id or t.merged_into_id = src.id
			join story_tags st on st.tag_id = t.id
			join listed l on l.story_id = st.story_id
		), weights as (
			select id, case when kind = 'genre' then ${GENRE_WEIGHT}::float8
				else ln((select count(*) from listed)::float8 / count(*)) end as weight
			from hits group by id, kind
		), scored as (
			select h.story_id, sum(w.weight) as score
			from hits h join weights w on w.id = h.id
			where h.story_id <> ${storyId}::uuid
			group by h.story_id
		)
		select ${BOOK_COLUMNS}
		${BOOK_FROM}
		join scored on scored.story_id = p.story_id
		where ${listedInBrowseCondition} and scored.score > ${MIN_SIMILAR_SCORE}
			${adult ? sql`` : sql`and not p.is_adult`}
		order by scored.score desc, p.published_at desc, p.id desc
		limit ${SIMILAR_LIMIT}
	`);
	return toBooks(db, result.rows as BookRow[]);
}

// Authors whose name matches a search, with at least one listed story that
// the query's other filters let through, counting only those stories. Only
// the name readers see (see shownName).
export async function browseAuthors(db: Database, query: BrowseQuery, filters: BrowseFilters) {
	if (!query.q) return [];
	const filtered = filterConditions(query, filters);
	if (!filtered) return [];
	const like = pattern(query.q);
	const result = await db.execute(sql`
		select p.handle, u.pen_name, u.display_name, count(distinct p.story_id)::int as stories
		from publications p
		join stories s on s.id = p.story_id
		join users u on u.id = p.owner_id
		join universes un on un.id = s.universe_id
		where ${sql.join([listedInBrowseCondition, ...filtered, sql`${shownName} ilike ${like}`], sql` and `)}
		group by p.handle, u.pen_name, u.display_name
		order by count(distinct p.story_id) desc, p.handle
		limit 6
	`);
	return (
		result.rows as {
			handle: string;
			pen_name: string | null;
			display_name: string | null;
			stories: number;
		}[]
	).map((row) => ({
		handle: row.handle,
		name: authorName({ penName: row.pen_name, displayName: row.display_name }) || `@${row.handle}`,
		stories: row.stories
	}));
}

// The free-form tags on listed stories, for the tag box's suggestions, so an
// author is only offered tags readers can already find. Newest stories first,
// capped, since this is a hint and not a directory.
export async function browseTagSuggestions(db: Database): Promise<string[]> {
	const result = await db.execute(sql`
		select p.story_id
		from publications p
		join stories s on s.id = p.story_id
		join users u on u.id = p.owner_id
		where ${listedInBrowseCondition}
		order by p.published_at desc
		limit 500
	`);
	const labels = await tagsForStories(
		db,
		(result.rows as { story_id: string }[]).map((row) => row.story_id)
	);
	const names = new Set<string>();
	for (const list of labels.values()) {
		for (const tag of list) if (tag.kind === 'tag') names.add(tag.name);
	}
	return [...names].sort((a, b) => a.localeCompare(b)).slice(0, 300);
}

// ============ Listing and moderation ============

// Saves a story's visibility, adult flag and Browse listing together. Only a
// public story stays listed, and never while a moderator has removed it from
// Browse; the block is checked in the update itself, so a save racing a
// removal cannot list the story again. `listed` is null to keep the stored
// choice (the box is hidden while Browse is off).
export async function saveStoryVisibility(
	db: Database,
	storyId: string,
	visibility: 'private' | 'unlisted' | 'public',
	isAdult: boolean,
	listed: boolean | null
): Promise<void> {
	const keep = listed === null ? sql`${stories.listedInBrowse}` : sql`${listed}::boolean`;
	await db
		.update(stories)
		.set({
			visibility,
			isAdult,
			listedInBrowse:
				visibility === 'public' ? sql`(${keep} and ${stories.browseBlockedAt} is null)` : false
		})
		.where(eq(stories.id, storyId));
}

// A moderator takes a story off Browse and keeps it off until allowed again.
// Its pages stay up; that is what a takedown is for. The report acted on
// closes; others stay open.
export async function removeFromBrowse(
	db: Database,
	storyId: string,
	by: string,
	reason: ReportReason,
	// The report the moderator acted on, which closes. Other reports on the
	// story stay open: its pages are still up, so they may need a takedown.
	// When that report is already closed (another moderator got there first),
	// nothing changes and the result is 'report-closed'.
	reportId: string | null = null
	// 'withdrawn' when the moderator may not read the story's current edition
	// (the writer made it private or moved it to the trash, or never published
	// it) nor the open report's edition.
): Promise<boolean | 'report-closed' | 'withdrawn'> {
	const closed = Symbol('report-closed');
	return await db
		.transaction(async (tx) => {
			// The lock saveStoryVisibility's update and the takedown also take, so
			// the check below sees a visibility change that just committed.
			const [story] = await tx
				.select({ id: stories.id })
				.from(stories)
				.where(eq(stories.id, storyId))
				.for('update');
			if (!story) return false;
			const [readable] = await tx
				.select({ id: publications.id })
				.from(publications)
				.innerJoin(stories, eq(stories.id, publications.storyId))
				.where(
					and(
						eq(publications.storyId, storyId),
						moderatorMayRead(),
						// The current edition, or the edition of the report acted on,
						// which an open report lets the moderator read.
						reportId
							? or(
									eq(publications.isCurrent, true),
									inArray(
										publications.id,
										tx
											.select({ id: publicationReports.publicationId })
											.from(publicationReports)
											.where(eq(publicationReports.id, reportId))
									)
								)
							: eq(publications.isCurrent, true)
					)
				)
				.limit(1);
			if (!readable) return 'withdrawn' as const;
			const updated = await tx
				.update(stories)
				.set({
					listedInBrowse: false,
					browseBlockedAt: sql`now()`,
					browseBlockedBy: by,
					browseBlockedReason: reason
				})
				.where(and(eq(stories.id, storyId), isNull(stories.browseBlockedAt)))
				.returning({ id: stories.id });
			if (updated.length === 0) return false;
			if (!reportId) return true;
			const resolved = await tx
				.update(publicationReports)
				.set({ resolvedAt: sql`now()`, resolvedBy: by, resolution: 'removed_from_browse' })
				.where(
					and(
						eq(publicationReports.id, reportId),
						isNull(publicationReports.resolvedAt),
						inArray(
							publicationReports.publicationId,
							tx
								.select({ id: publications.id })
								.from(publications)
								.where(eq(publications.storyId, storyId))
						)
					)
				)
				.returning({ id: publicationReports.id });
			if (resolved.length === 0) throw closed;
			return true;
		})
		.catch((caught) => {
			if (caught === closed) return 'report-closed' as const;
			throw caught;
		});
}

// Lets the author list the story again. It does not list it for them.
export async function allowInBrowse(
	db: Database,
	storyId: string,
	allowedBy: string | null,
	// When the moderator's page showed the story removed, as microsText
	// (listBrowseBlocked's browseBlockedMicros). Refused with 'changed' when
	// the removal now is a later one; left out, nothing is checked.
	{ blockedShown }: { blockedShown?: string } = {}
): Promise<boolean | 'changed'> {
	const updated = await db
		.update(stories)
		.set({
			browseBlockedAt: null,
			browseBlockedBy: null,
			browseBlockedReason: null,
			browseAllowedAt: sql`now()`,
			browseAllowedBy: allowedBy
		})
		.where(
			and(
				eq(stories.id, storyId),
				sql`${stories.browseBlockedAt} is not null`,
				// In SQL, to the microsecond: a JS Date would drop them.
				blockedShown === undefined
					? undefined
					: sql`${microsText(stories.browseBlockedAt)} = ${blockedShown}`
			)
		)
		.returning({ id: stories.id });
	if (updated.length > 0) return true;
	if (blockedShown === undefined) return false;
	const [still] = await db
		.select({ id: stories.id })
		.from(stories)
		.where(and(eq(stories.id, storyId), isNotNull(stories.browseBlockedAt)));
	return still ? 'changed' : false;
}
