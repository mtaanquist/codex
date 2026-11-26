import { and, asc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { stories, storyTags, tags, universes } from './db/schema.ts';
import { isUniqueViolation } from './db-errors.ts';
import { pageIndex } from './paging.ts';
import { pattern } from './search.ts';
import { isUuid } from '../slug.ts';
import { cleanTagName, MAX_FANDOMS, MAX_TAG_LENGTH, MAX_TAGS, tagSlug } from '../story-tags.ts';
import { warningKey } from '../assistant-preferences.ts';

// Free-form tags and the curated lists (fandoms, genres, content warnings).
// Reads always follow a merge to the surviving entry and hide removed ones, so
// a merge or a removal applies to every story at once without moving any rows.

export type TagKind = 'tag' | 'fandom' | 'genre' | 'warning';
// The kinds moderators curate and authors only pick from.
export type ListKind = Exclude<TagKind, 'tag'>;
export type ShownTag = {
	id: string;
	kind: TagKind;
	name: string;
	slug: string;
	// Comes from the story's universe, not the story itself.
	inherited?: true;
};

// Follows merged_into_id from each start id to the surviving tag. A merge
// keeps every chain one step deep; the cap guards reads against a cycle or a
// longer chain left by older data.
const MAX_MERGE_DEPTH = 8;

// The visible labels on each story, by story id, including the fandom its
// universe is linked to (marked inherited, unless the story also has it).
export async function tagsForStories(
	db: Database,
	storyIds: string[]
): Promise<Map<string, ShownTag[]>> {
	const result = new Map<string, ShownTag[]>();
	if (storyIds.length === 0) return result;
	const ids = sql`(${sql.join(
		storyIds.map((id) => sql`${id}::uuid`),
		sql`, `
	)})`;
	const rows = await db.execute(sql`
		with recursive base as (
			select st.story_id, st.tag_id, false as inherited
			from story_tags st where st.story_id in ${ids}
			union all
			select s.id, u.fandom_id, true
			from stories s join universes u on u.id = s.universe_id
			where s.id in ${ids} and u.fandom_id is not null
		), chain as (
			select b.story_id, b.inherited, t.id as start_id, t.id, t.merged_into_id, 0 as depth
			from base b join tags t on t.id = b.tag_id
			union all
			select c.story_id, c.inherited, c.start_id, t.id, t.merged_into_id, c.depth + 1
			from chain c join tags t on t.id = c.merged_into_id
			where c.depth < ${MAX_MERGE_DEPTH}
		), final as (
			select distinct on (story_id, inherited, start_id) story_id, inherited, id
			from chain order by story_id, inherited, start_id, depth desc
		)
		select f.story_id, t.id, t.kind, t.name, t.slug, bool_and(f.inherited) as inherited
		from final f join tags t on t.id = f.id
		where t.removed_at is null
		group by f.story_id, t.id, t.kind, t.name, t.slug
		order by t.name
	`);
	for (const row of rows.rows as {
		story_id: string;
		id: string;
		kind: TagKind;
		name: string;
		slug: string;
		inherited: boolean;
	}[]) {
		const list = result.get(row.story_id) ?? [];
		list.push({
			id: row.id,
			kind: row.kind,
			name: row.name,
			slug: row.slug,
			...(row.inherited && { inherited: true })
		});
		result.set(row.story_id, list);
	}
	return result;
}

export async function storyTagView(db: Database, storyId: string) {
	const shown = (await tagsForStories(db, [storyId])).get(storyId) ?? [];
	return {
		tags: shown.filter((tag) => tag.kind === 'tag'),
		fandoms: shown.filter((tag) => tag.kind === 'fandom'),
		genres: shown.filter((tag) => tag.kind === 'genre'),
		warnings: shown.filter((tag) => tag.kind === 'warning')
	};
}

// Cleans typed tag names, keyed by slug (the first spelling wins), or says
// why one cannot be used. The limit counts the tags the story would show, so
// a merged-away name and its survivor count once. Nothing is written.
export async function checkTagNames(
	db: Database,
	names: string[],
	// How many the story shows now. A story already over the limit (after an
	// unmerge or a restore) may keep them but not add more.
	currentCount = 0
): Promise<{ ok: true; tags: Map<string, string> } | { ok: false; message: string }> {
	const cleaned = new Map<string, string>();
	for (const raw of names) {
		const result = cleanTagName(raw);
		if (!result.ok) {
			if (!result.empty) return { ok: false, message: result.reason };
			continue;
		}
		const slug = tagSlug(result.name);
		if (!cleaned.has(slug)) cleaned.set(slug, result.name);
	}
	const limit = Math.max(MAX_TAGS, currentCount);
	if (cleaned.size > limit) {
		const shown = new Set((await tagSurvivors(db, [...cleaned.keys()])).values());
		shown.delete(null);
		if (shown.size > limit) {
			return { ok: false, message: `A story can have up to ${MAX_TAGS} tags.` };
		}
	}
	return { ok: true, tags: cleaned };
}

// What each free-form tag slug would show as on a story: the id of the
// surviving tag, the slug itself for a tag that does not exist yet, or null
// for one that would not show (removed, or merged into a removed tag).
export async function tagSurvivors(
	db: Database,
	slugs: string[]
): Promise<Map<string, string | null>> {
	const result = new Map<string, string | null>(slugs.map((slug) => [slug, `new:${slug}`]));
	if (slugs.length === 0) return result;
	const rows = await db.execute(sql`
		with recursive chain as (
			select t.slug as start_slug, t.id, t.removed_at is not null as start_removed, 0 as depth
			from tags t
			where t.kind = 'tag' and t.slug in (${sql.join(
				slugs.map((slug) => sql`${slug}`),
				sql`, `
			)})
			union all
			select c.start_slug, t.id, c.start_removed, c.depth + 1 from chain c
			join tags m on m.id = c.id join tags t on t.id = m.merged_into_id
			where c.depth < ${MAX_MERGE_DEPTH}
		)
		select distinct on (c.start_slug) c.start_slug, t.id,
			c.start_removed or t.removed_at is not null as hidden
		from chain c join tags t on t.id = c.id
		order by c.start_slug, c.depth desc
	`);
	for (const row of rows.rows as { start_slug: string; id: string; hidden: boolean }[]) {
		result.set(row.start_slug, row.hidden ? null : row.id);
	}
	return result;
}

// Replaces a story's free-form tags. A slug that matches an existing tag
// reuses it (a merged one keeps pointing at its survivor); a removed tag, or
// one merged into a removed tag, cannot be added and comes back in `skipped`.
export async function setStoryTags(
	db: Database,
	storyId: string,
	cleaned: Map<string, string>
): Promise<{ skipped: string[] }> {
	const skipped: string[] = [];
	await db.transaction(async (tx) => {
		if (cleaned.size > 0) {
			await tx
				.insert(tags)
				.values([...cleaned].map(([slug, name]) => ({ kind: 'tag' as const, name, slug })))
				.onConflictDoNothing({ target: [tags.kind, tags.slug] });
		}
		const found =
			cleaned.size === 0
				? []
				: await tx
						.select({ id: tags.id, name: tags.name, slug: tags.slug })
						.from(tags)
						.where(and(eq(tags.kind, 'tag'), inArray(tags.slug, [...cleaned.keys()])));
		const survivors = await tagSurvivors(tx, [...cleaned.keys()]);
		const keep = found.filter((tag) => {
			const hidden = survivors.get(tag.slug) === null;
			if (hidden) skipped.push(tag.name);
			return !hidden;
		});
		await replaceStoryTags(
			tx,
			storyId,
			'tag',
			keep.map((tag) => tag.id)
		);
	});
	return { skipped };
}

// Matches names against a curated list by slug, following merges to the
// surviving entry. ids are the survivors in the order the names came, without
// repeats, so a merged-away name and its survivor count once. Removed entries
// (or a name whose survivor is removed) do not match. Nothing is written.
export async function listedByName(
	db: Database,
	kind: ListKind,
	names: string[]
): Promise<{ ids: string[]; slugs: string[]; missing: string[] }> {
	const slugs = [...new Set(names.map(tagSlug).filter(Boolean))];
	const survivors = new Map<string, { id: string; slug: string }>();
	if (slugs.length > 0) {
		const rows = await db.execute(sql`
			with recursive chain as (
				select t.slug as start_slug, t.id, 0 as depth from tags t
				where t.kind = ${kind} and t.removed_at is null and t.slug in (${sql.join(
					slugs.map((slug) => sql`${slug}`),
					sql`, `
				)})
				union all
				select c.start_slug, t.id, c.depth + 1 from chain c
				join tags m on m.id = c.id join tags t on t.id = m.merged_into_id
				where c.depth < ${MAX_MERGE_DEPTH}
			)
			select distinct on (c.start_slug) c.start_slug, t.id, t.slug,
				t.removed_at is null and t.merged_into_id is null as current
			from chain c join tags t on t.id = c.id
			order by c.start_slug, c.depth desc
		`);
		for (const row of rows.rows as {
			start_slug: string;
			id: string;
			slug: string;
			current: boolean;
		}[]) {
			if (row.current) survivors.set(row.start_slug, { id: row.id, slug: row.slug });
		}
	}
	const found = new Map<string, string>();
	const missing: string[] = [];
	for (const name of names) {
		const survivor = survivors.get(tagSlug(name));
		if (!survivor) missing.push(name);
		else found.set(survivor.id, survivor.slug);
	}
	return { ids: [...found.keys()], slugs: [...found.values()], missing };
}

// Finds fandoms on the curated list by name. A name not on it is refused;
// authors cannot add fandoms. inheritedSlugs are the fandoms the story's
// universe already gives it: they count toward the limit and are not stored
// on the story again. Nothing is written.
export async function findFandoms(
	db: Database,
	typed: string[],
	inheritedSlugs: string[] = [],
	// How many the story has now, own and inherited. A story already over the
	// limit (its universe was linked later) may keep them but not add more.
	currentCount = 0
): Promise<{ ok: true; ids: string[] } | { ok: false; message: string }> {
	const found = await listedByName(db, 'fandom', typed);
	if (found.missing.length > 0) {
		return {
			ok: false,
			message: `Not on the fandom list: ${found.missing.join(', ')}. Use a tag instead, or ask the people who run this site to add it.`
		};
	}
	const ids = found.ids.filter((_, i) => !inheritedSlugs.includes(found.slugs[i]));
	if (ids.length + inheritedSlugs.length > Math.max(MAX_FANDOMS, currentCount)) {
		return {
			ok: false,
			message:
				inheritedSlugs.length > 0
					? `A story can have up to ${MAX_FANDOMS} fandoms, including the one its universe is set in.`
					: `A story can have up to ${MAX_FANDOMS} fandoms.`
		};
	}
	return { ok: true, ids };
}

// The ids from a submitted form that are current entries of a list (not
// removed, not merged away), in list order, without repeats.
export async function pickListed(db: Database, kind: ListKind, values: unknown[]) {
	const wanted = [
		...new Set(
			values.filter((value): value is string => typeof value === 'string' && isUuid(value))
		)
	];
	if (wanted.length === 0) return [];
	const rows = await db
		.select({ id: tags.id })
		.from(tags)
		.where(
			and(
				eq(tags.kind, kind),
				inArray(tags.id, wanted),
				isNull(tags.removedAt),
				isNull(tags.mergedIntoId)
			)
		)
		.orderBy(asc(tags.name));
	return rows.map((row) => row.id);
}

// Replaces a story's entries of one curated list.
export async function setStoryList(db: Database, storyId: string, kind: ListKind, ids: string[]) {
	await db.transaction(async (tx) => {
		await replaceStoryTags(tx, storyId, kind, ids);
	});
}

// Replaces a story's entries of one kind with the ones the writer submitted.
// The form shows merged entries as the entry they were merged into and hides
// removed ones, so a save keeps the rows it could not show: a merged entry
// whose survivor was submitted, and an entry whose survivor is removed (the
// same rule tagsForStories hides by). Undoing the merge or the
// removal then gives the story its old entry back.
async function replaceStoryTags(tx: Database, storyId: string, kind: TagKind, tagIds: string[]) {
	const existing = await tx.execute(sql`
		with recursive chain as (
			select t.id as start_id, t.id, t.merged_into_id, t.removed_at is not null as removed, 0 as depth
			from story_tags st join tags t on t.id = st.tag_id
			where st.story_id = ${storyId} and t.kind = ${kind}
			union all
			select c.start_id, t.id, t.merged_into_id, t.removed_at is not null, c.depth + 1
			from chain c join tags t on t.id = c.merged_into_id
			where c.depth < ${MAX_MERGE_DEPTH}
		)
		select distinct on (start_id) start_id, id as survivor_id, removed
		from chain order by start_id, depth desc
	`);
	const wanted = new Set(tagIds);
	const kept = (
		existing.rows as { start_id: string; survivor_id: string; removed: boolean }[]
	).filter((row) => row.removed || wanted.has(row.survivor_id));
	const keptIds = kept.map((row) => row.start_id);
	await tx.execute(sql`
		delete from story_tags st using tags t
		where st.tag_id = t.id and st.story_id = ${storyId} and t.kind = ${kind}
		${
			keptIds.length > 0
				? sql`and st.tag_id not in (${sql.join(
						keptIds.map((id) => sql`${id}::uuid`),
						sql`, `
					)})`
				: sql``
		}
	`);
	const covered = new Set(kept.map((row) => row.survivor_id));
	const added = tagIds.filter((id) => !covered.has(id));
	if (added.length > 0) {
		await tx
			.insert(storyTags)
			.values(added.map((tagId) => ({ storyId, tagId })))
			.onConflictDoNothing();
	}
}

// The current entries of a curated list, for authors to pick from.
export async function listEntries(
	db: Database,
	kind: ListKind
): Promise<{ id: string; name: string; slug: string }[]> {
	return await db
		.select({ id: tags.id, name: tags.name, slug: tags.slug })
		.from(tags)
		.where(and(eq(tags.kind, kind), isNull(tags.removedAt), isNull(tags.mergedIntoId)))
		.orderBy(asc(tags.name));
}

// ============ Moderation ============

const PAGE_SIZE = 50;

// The tags or fandoms with how many stories carry each, for the moderation
// pages. A fandom counts stories that get it from their universe too, each
// story once. Stories in the trash count until they are purged. A merge only
// points the entry at its survivor, so a merged-away entry keeps its own count
// and the survivor's count does not include it. Removed ones are listed too,
// so they can be restored.
export async function listTagsForModeration(
	db: Database,
	kind: TagKind,
	options: { query?: string; page?: number } = {}
) {
	const page = pageIndex(options.page ?? 0);
	const query = options.query?.trim() ?? '';
	const target = sql`(select name from tags m where m.id = ${tags.mergedIntoId})`;
	const rows = await db
		.select({
			id: tags.id,
			name: tags.name,
			slug: tags.slug,
			removedAt: tags.removedAt,
			mergedIntoId: tags.mergedIntoId,
			mergedIntoName: sql<string | null>`${target}`,
			// Written out: drizzle leaves a column of the only table unqualified,
			// which the subquery's own id columns would shadow.
			uses: sql<number>`(select count(*)::int from (
				select st.story_id from story_tags st where st.tag_id = tags.id
				union
				select s.id from stories s join universes u on u.id = s.universe_id
				where u.fandom_id = tags.id
			) used)`
		})
		.from(tags)
		.where(and(eq(tags.kind, kind), query ? ilike(tags.name, pattern(query)) : undefined))
		.orderBy(asc(tags.name))
		.limit(PAGE_SIZE + 1)
		.offset(page * PAGE_SIZE);
	return { rows: rows.slice(0, PAGE_SIZE), page, more: rows.length > PAGE_SIZE };
}

type ModResult = { ok: true } | { ok: false; message: string };

// The moderation functions below take the kind the page manages, so an id
// of another kind is not found.

// Renames a tag or fandom. Its slug follows the new name, so a name that
// another entry of the same kind already has is refused: merge them instead.
export async function renameTag(
	db: Database,
	kind: TagKind,
	id: string,
	rawName: string
): Promise<ModResult> {
	const cleaned = cleanTagName(rawName);
	if (!cleaned.ok) return { ok: false, message: cleaned.reason };
	const slug = tagSlug(cleaned.name);
	const [tag] = await db
		.select()
		.from(tags)
		.where(and(eq(tags.id, id), eq(tags.kind, kind)));
	if (!tag) return { ok: false, message: 'That entry does not exist.' };
	const clashMessage = 'Another entry already has that name. Merge them instead.';
	const [clash] = await db
		.select({ id: tags.id, name: tags.name, removedAt: tags.removedAt })
		.from(tags)
		.where(and(eq(tags.kind, tag.kind), eq(tags.slug, slug)));
	if (clash && clash.id !== id) {
		return {
			ok: false,
			message: clash.removedAt
				? `The removed entry "${clash.name}" has that name. Restore it and merge into it, or pick another name.`
				: clashMessage
		};
	}
	try {
		await db.update(tags).set({ name: cleaned.name, slug }).where(eq(tags.id, id));
	} catch (err) {
		// Another rename, or a writer adding that tag, took the slug since the check.
		if (isUniqueViolation(err)) return { ok: false, message: clashMessage };
		throw err;
	}
	return { ok: true };
}

// Points a tag at another of the same kind. Reads follow it, so every story
// with the source shows the target; undoing only clears the pointer. A merge
// always lands on a surviving entry and takes the source's own merged entries
// with it, so no chain is ever more than one step.
export async function mergeTag(
	db: Database,
	kind: TagKind,
	sourceId: string,
	targetName: string
): Promise<ModResult> {
	return await db.transaction(async (tx) => {
		const [source] = await tx
			.select()
			.from(tags)
			.where(and(eq(tags.id, sourceId), eq(tags.kind, kind)));
		if (!source) return { ok: false, message: 'That entry does not exist.' };
		const notFound = `There is no ${source.kind} called "${targetName.trim()}".`;
		const [named] = await tx
			.select()
			.from(tags)
			.where(and(eq(tags.kind, source.kind), eq(tags.slug, tagSlug(targetName))));
		if (!named) return { ok: false, message: notFound };
		if (named.removedAt) {
			return {
				ok: false,
				message: `"${named.name}" is removed. Restore it first, then merge into it.`
			};
		}
		if (named.id === source.id) return { ok: false, message: 'Pick a different entry.' };
		const survivor = await survivorOf(tx, named.id);
		if (!survivor.ended) {
			return {
				ok: false,
				message: `"${named.name}" is merged in a loop or a chain too long to follow. Undo the merge on "${named.name}" first, then try again.`
			};
		}
		const survivorId = survivor.id;
		// Lock every row this changes, in id order, so two merges that touch the
		// same entries wait for each other instead of deadlocking or each passing
		// the checks below and pointing at one another.
		const locked = await tx
			.select()
			.from(tags)
			.where(or(inArray(tags.id, [source.id, survivorId]), eq(tags.mergedIntoId, source.id)))
			.orderBy(asc(tags.id))
			.for('update');
		if (survivorId === source.id) {
			return { ok: false, message: `"${named.name}" is already merged into "${source.name}".` };
		}
		// A merge that committed while this one waited can have moved the target.
		const target = locked.find((row) => row.id === survivorId);
		if (!target || target.mergedIntoId) {
			return { ok: false, message: 'That entry changed while you were working. Try again.' };
		}
		if (target.removedAt) {
			return {
				ok: false,
				message: `"${target.name}" is removed. Restore it first, then merge into it.`
			};
		}
		await tx
			.update(tags)
			.set({ mergedIntoId: target.id })
			.where(or(eq(tags.id, source.id), eq(tags.mergedIntoId, source.id)));
		if (source.kind === 'warning') {
			const children = locked.filter((row) => row.mergedIntoId === source.id);
			await carryContentLimits(
				tx,
				source.slug,
				children.map((row) => row.slug),
				target.slug
			);
		}
		return { ok: true };
	});
}

// A writer's content limits (Assistant preferences) on a warning merged away
// carry over to the surviving warning wherever none is set on it yet: the
// merged warning's own limit, else, from the warnings merged into it earlier
// (which the writer can no longer see), the more careful one. The old keys
// stay, so an undone merge keeps them.
async function carryContentLimits(
	tx: Database,
	sourceSlug: string,
	childSlugs: string[],
	toSlug: string
) {
	const own = warningKey(sourceSlug);
	const from = sql`array[${sql.join(
		[sourceSlug, ...childSlugs].map((slug) => sql`${warningKey(slug)}`),
		sql`, `
	)}]::text[]`;
	const to = warningKey(toSlug);
	const carry = (
		column: typeof stories.assistantPreferences | typeof universes.assistantPreferences
	) => ({
		set: sql`${column} || jsonb_build_object(${to}::text, case
			when ${column} ->> ${own}::text in ('avoid', 'write') then ${column} ->> ${own}::text
			when exists (select 1 from unnest(${from}) as k where ${column} ->> k = 'avoid') then 'avoid'
			else 'write' end)`,
		where: sql`jsonb_exists_any(${column}, ${from}) and not jsonb_exists(${column}, ${to}::text) and exists (select 1 from unnest(${from}) as k where ${column} ->> k in ('avoid', 'write'))`
	});
	// updated_at is kept as it was: this is the site's change, not the writer's.
	const story = carry(stories.assistantPreferences);
	await tx
		.update(stories)
		.set({ assistantPreferences: story.set, updatedAt: sql`${stories.updatedAt}` })
		.where(story.where);
	const universe = carry(universes.assistantPreferences);
	await tx
		.update(universes)
		.set({ assistantPreferences: universe.set, updatedAt: sql`${universes.updatedAt}` })
		.where(universe.where);
}

// The entry a tag's merges end at (the tag itself when it is not merged).
// ended is false when the merges never end within MAX_MERGE_DEPTH (a loop or
// a longer chain); migration 0125 repaired those, so it means broken data.
async function survivorOf(tx: Database, id: string): Promise<{ id: string; ended: boolean }> {
	const rows = await tx.execute(sql`
		with recursive chain as (
			select id, merged_into_id, 0 as depth from tags where id = ${id}
			union all
			select t.id, t.merged_into_id, c.depth + 1 from chain c join tags t on t.id = c.merged_into_id
			where c.depth < ${MAX_MERGE_DEPTH}
		)
		select id, merged_into_id is null as ended from chain order by depth desc limit 1
	`);
	const row = rows.rows[0] as { id: string; ended: boolean } | undefined;
	return row ?? { id, ended: true };
}

export async function unmergeTag(db: Database, kind: TagKind, id: string): Promise<boolean> {
	const updated = await db
		.update(tags)
		.set({ mergedIntoId: null })
		.where(and(eq(tags.id, id), eq(tags.kind, kind), sql`${tags.mergedIntoId} is not null`))
		.returning({ id: tags.id });
	return updated.length > 0;
}

export async function setTagRemoved(
	db: Database,
	kind: TagKind,
	id: string,
	removed: boolean,
	by: string
): Promise<boolean> {
	const updated = await db
		.update(tags)
		.set(removed ? { removedAt: sql`now()`, removedBy: by } : { removedAt: null, removedBy: null })
		.where(and(eq(tags.id, id), eq(tags.kind, kind)))
		.returning({ id: tags.id });
	return updated.length > 0;
}

// Adds entries to a curated list from a multi-line box, one name per line.
// Names already on the list (by slug) are skipped and reported: in skipped,
// or in removed when the entry they match was removed, since only a restore
// brings that one back.
export async function addListEntries(
	db: Database,
	kind: ListKind,
	text: string
): Promise<
	| { ok: true; added: string[]; skipped: string[]; removed: string[] }
	| { ok: false; message: string }
> {
	const wanted = new Map<string, string>();
	for (const line of text.split('\n')) {
		const cleaned = cleanTagName(line);
		if (!cleaned.ok) {
			if (cleaned.empty) continue;
			return { ok: false, message: cleaned.reason };
		}
		const slug = tagSlug(cleaned.name);
		if (!wanted.has(slug)) wanted.set(slug, cleaned.name);
	}
	if (wanted.size === 0) return { ok: false, message: 'Write one name per line.' };
	const inserted = await db
		.insert(tags)
		.values([...wanted].map(([slug, name]) => ({ kind, name, slug })))
		.onConflictDoNothing({ target: [tags.kind, tags.slug] })
		.returning({ slug: tags.slug, name: tags.name });
	const addedSlugs = new Set(inserted.map((row) => row.slug));
	const existing = [...wanted].filter(([slug]) => !addedSlugs.has(slug));
	const removedSlugs = new Set(
		existing.length === 0
			? []
			: (
					await db
						.select({ slug: tags.slug })
						.from(tags)
						.where(
							and(
								eq(tags.kind, kind),
								inArray(
									tags.slug,
									existing.map(([slug]) => slug)
								),
								isNotNull(tags.removedAt)
							)
						)
				).map((row) => row.slug)
	);
	return {
		ok: true,
		added: inserted.map((row) => row.name),
		skipped: existing.filter(([slug]) => !removedSlugs.has(slug)).map(([, name]) => name),
		removed: existing.filter(([slug]) => removedSlugs.has(slug)).map(([, name]) => name)
	};
}

// ============ Universe fandoms ============

// Fandoms whose name is close to what a writer is typing, for the universe
// name box: a substring match or a trigram match, best first.
export async function suggestFandoms(
	db: Database,
	query: string
): Promise<{ id: string; name: string }[]> {
	const q = query.trim().slice(0, MAX_TAG_LENGTH);
	if (q.length < 2) return [];
	const rows = await db.execute(sql`
		select id, name from tags
		where kind = 'fandom' and removed_at is null and merged_into_id is null
			and (name ilike ${pattern(q)} or word_similarity(${q}, name) > 0.4)
		order by word_similarity(${q}, name) desc, name
		limit 8
	`);
	return rows.rows as { id: string; name: string }[];
}

// A current entry of the fandom list (not removed or merged away), or null.
export async function pickableFandom(
	db: Database,
	fandomId: string
): Promise<{ id: string } | null> {
	if (!isUuid(fandomId)) return null;
	const [fandom] = await db
		.select({ id: tags.id })
		.from(tags)
		.where(
			and(
				eq(tags.id, fandomId),
				eq(tags.kind, 'fandom'),
				isNull(tags.removedAt),
				isNull(tags.mergedIntoId)
			)
		);
	return fandom ?? null;
}

// Links a universe to a fandom on the list, or unlinks it with null. Linking
// also marks the universe a canon setting; unlinking leaves that flag alone.
// False when the fandom is not a current entry of the list.
export async function setUniverseFandom(
	db: Database,
	universeId: string,
	fandomId: string | null
): Promise<boolean> {
	if (fandomId === null) {
		await db.update(universes).set({ fandomId: null }).where(eq(universes.id, universeId));
		return true;
	}
	const fandom = await pickableFandom(db, fandomId);
	if (!fandom) return false;
	await db
		.update(universes)
		.set({ fandomId: fandom.id, establishedSetting: true })
		.where(eq(universes.id, universeId));
	return true;
}

// The fandom a universe is linked to, followed through merges, or null when
// it has none or the fandom was removed.
export async function universeFandom(
	db: Database,
	universeId: string
): Promise<{ id: string; name: string } | null> {
	const rows = await db.execute(sql`
		with recursive chain as (
			select t.id, t.merged_into_id, 0 as depth
			from universes u join tags t on t.id = u.fandom_id where u.id = ${universeId}
			union all
			select t.id, t.merged_into_id, c.depth + 1 from chain c join tags t on t.id = c.merged_into_id
			where c.depth < ${MAX_MERGE_DEPTH}
		)
		select t.id, t.name, t.removed_at from chain c join tags t on t.id = c.id
		order by c.depth desc limit 1
	`);
	const row = rows.rows[0] as { id: string; name: string; removed_at: unknown } | undefined;
	return row && !row.removed_at ? { id: row.id, name: row.name } : null;
}
