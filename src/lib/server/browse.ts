import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { publicationReports, publications, stories, tags } from './db/schema.ts';
import { pattern } from './search.ts';
import { tagsForStories, type ListKind, type TagKind } from './tags.ts';
import { storyCoverColor } from '../entity-color.ts';
import { authorName } from '../author-name.ts';
import { slugAddress } from '../slug.ts';
import { BROWSE_PAGE_SIZE, encodeCursor, type BrowseQuery } from '../browse.ts';
import type { ReportReason } from '../report-reasons.ts';

// The public Browse page: current editions of public stories their authors
// listed, across the whole instance. Unlisted and private stories never show.

const MAX_MERGE_DEPTH = 8;

// The condition every listed story meets. Expects publications p, stories s
// and users u in the FROM.
const listed = sql`
	p.is_current and p.removed_at is null
	and s.owner_id = p.owner_id
	and s.deleted_at is null
	and exists (select 1 from universes lu where lu.id = s.universe_id and lu.deleted_at is null)
	and s.visibility = 'public' and s.listed_in_browse and s.browse_blocked_at is null
	and u.suspended_at is null and u.deletion_scheduled_at is null and not u.hidden_from_browse
`;

// An edition's publish time in whole microseconds, for the page cursor.
const MICROS = sql.raw('(extract(epoch from p.published_at) * 1000000)::bigint');

type FilterTag = { name: string; slug: string; ids: string[] };

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
			select id, 0 as depth from tags where id = ${tag.id}
			union all
			select t.id, c.depth + 1 from tags t join closure c on t.merged_into_id = c.id
			where c.depth < ${MAX_MERGE_DEPTH}
		)
		select distinct id from closure
	`);
	return {
		name: tag.name,
		slug: tag.slug,
		ids: (closure.rows as { id: string }[]).map((row) => row.id)
	};
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

export async function browseStories(
	db: Database,
	query: BrowseQuery,
	filters: BrowseFilters
): Promise<{ books: BrowseBook[]; next: string | null }> {
	// A filter that names a missing or removed entry matches nothing.
	if ((query.genre && !filters.genre) || (query.fandom && !filters.fandom)) {
		return { books: [], next: null };
	}
	if (query.tag && !filters.tag) return { books: [], next: null };

	const conditions: SQL[] = [listed];
	if (!query.adult) conditions.push(sql`not p.is_adult`);
	if (query.q) {
		const like = pattern(query.q);
		conditions.push(sql`(
			p.title ilike ${like} or p.author ilike ${like} or p.description_md ilike ${like}
			or ${shownName} ilike ${like}
			or (not un.standalone and un.name ilike ${like})
		)`);
	}
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
		// publish, so a reader is not shown a warning they asked to avoid.
		conditions.push(sql`not ${hasAny(filters.hide.flatMap((tag) => tag.ids))}`);
		conditions.push(
			sql`not (p.content_warnings && array[${sql.join(
				filters.hide.map((tag) => sql`${tag.name}`),
				sql`, `
			)}]::text[])`
		);
	}
	if (query.after) {
		conditions.push(
			sql`(${MICROS}, p.id) < (${query.after.micros}::bigint, ${query.after.id}::uuid)`
		);
	}

	const result = await db.execute(sql`
		select p.id as publication_id, p.story_id, s.slug, p.title, p.description_md, p.is_adult,
			p.published_at, ${MICROS}::text as published_micros, s.cover_asset_id, s.cover_color, p.handle, p.author,
			u.pen_name, u.display_name, un.id as universe_id, un.name as universe_name, un.slug as universe_slug,
			un.standalone
		from publications p
		join stories s on s.id = p.story_id
		join users u on u.id = p.owner_id
		join universes un on un.id = s.universe_id
		where ${sql.join(conditions, sql` and `)}
		order by p.published_at desc, p.id desc
		limit ${BROWSE_PAGE_SIZE + 1}
	`);
	type Row = {
		publication_id: string;
		story_id: string;
		slug: string;
		title: string;
		description_md: string | null;
		is_adult: boolean;
		published_at: string | Date;
		published_micros: string;
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
	const rows = result.rows as Row[];
	const page = rows.slice(0, BROWSE_PAGE_SIZE);
	const labels = await tagsForStories(
		db,
		page.map((row) => row.story_id)
	);
	const books = page.map((row) => ({
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
	const last = page[page.length - 1];
	return {
		books,
		next:
			rows.length > BROWSE_PAGE_SIZE && last
				? encodeCursor(last.published_micros, last.publication_id)
				: null
	};
}

// Authors whose name matches a search, with at least one listed story.
// Only the name readers see (see shownName). Adult-only authors are left out
// unless the reader asked for adult work.
export async function browseAuthors(db: Database, q: string, adult = false) {
	if (!q) return [];
	const like = pattern(q);
	const result = await db.execute(sql`
		select p.handle, u.pen_name, u.display_name, count(distinct p.story_id)::int as stories
		from publications p
		join stories s on s.id = p.story_id
		join users u on u.id = p.owner_id
		where ${listed}
			and ${shownName} ilike ${like}
			${adult ? sql`` : sql`and not p.is_adult`}
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
		where ${listed}
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
// Its pages stay up; that is what a takedown is for. Open reports on the
// story's editions close as handled.
export async function removeFromBrowse(
	db: Database,
	storyId: string,
	by: string,
	reason: ReportReason,
	// The report the moderator acted on, which closes. Other reports on the
	// story stay open: its pages are still up, so they may need a takedown.
	reportId: string | null = null
): Promise<boolean> {
	return await db.transaction(async (tx) => {
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
		await tx
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
			);
		return true;
	});
}

// Lets the author list the story again. It does not list it for them.
export async function allowInBrowse(db: Database, storyId: string): Promise<boolean> {
	const updated = await db
		.update(stories)
		.set({ browseBlockedAt: null, browseBlockedBy: null, browseBlockedReason: null })
		.where(and(eq(stories.id, storyId), sql`${stories.browseBlockedAt} is not null`))
		.returning({ id: stories.id });
	return updated.length > 0;
}
