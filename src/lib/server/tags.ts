import { and, asc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { storyTags, tags } from './db/schema.ts';
import { pattern } from './search.ts';
import { isUuid } from '../slug.ts';
import { cleanTagName, MAX_FANDOMS, MAX_TAGS, tagSlug } from '../story-tags.ts';

// Free-form tags and the curated lists (fandoms, genres, content warnings).
// Reads always follow a merge to the surviving entry and hide removed ones, so
// a merge or a removal applies to every story at once without moving any rows.

export type TagKind = 'tag' | 'fandom' | 'genre' | 'warning';
// The kinds moderators curate and authors only pick from.
export type ListKind = Exclude<TagKind, 'tag'>;
export type ShownTag = { id: string; kind: TagKind; name: string; slug: string };

// Follows merged_into_id from each start id to the surviving tag. The depth
// cap only guards against a cycle that a merge check missed.
const MAX_MERGE_DEPTH = 8;

// The visible tags and fandoms on each story, by story id.
export async function tagsForStories(
	db: Database,
	storyIds: string[]
): Promise<Map<string, ShownTag[]>> {
	const result = new Map<string, ShownTag[]>();
	if (storyIds.length === 0) return result;
	const rows = await db.execute(sql`
		with recursive chain as (
			select st.story_id, t.id as start_id, t.id, t.merged_into_id, 0 as depth
			from story_tags st join tags t on t.id = st.tag_id
			where st.story_id in ${sql`(${sql.join(
				storyIds.map((id) => sql`${id}::uuid`),
				sql`, `
			)})`}
			union all
			select c.story_id, c.start_id, t.id, t.merged_into_id, c.depth + 1
			from chain c join tags t on t.id = c.merged_into_id
			where c.depth < ${MAX_MERGE_DEPTH}
		), final as (
			select distinct on (story_id, start_id) story_id, id
			from chain order by story_id, start_id, depth desc
		)
		select distinct f.story_id, t.id, t.kind, t.name, t.slug
		from final f join tags t on t.id = f.id
		where t.removed_at is null
		order by t.name
	`);
	for (const row of rows.rows as {
		story_id: string;
		id: string;
		kind: TagKind;
		name: string;
		slug: string;
	}[]) {
		const list = result.get(row.story_id) ?? [];
		list.push({ id: row.id, kind: row.kind, name: row.name, slug: row.slug });
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
// why one cannot be used. Nothing is written.
export function checkTagNames(
	names: string[]
): { ok: true; tags: Map<string, string> } | { ok: false; message: string } {
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
	if (cleaned.size > MAX_TAGS) {
		return { ok: false, message: `A story can have up to ${MAX_TAGS} tags.` };
	}
	return { ok: true, tags: cleaned };
}

// Replaces a story's free-form tags. A slug that matches an existing tag
// reuses it (a merged one keeps pointing at its survivor); a removed tag
// cannot be added back and comes back in `skipped`.
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
						.select({ id: tags.id, name: tags.name, removedAt: tags.removedAt })
						.from(tags)
						.where(and(eq(tags.kind, 'tag'), inArray(tags.slug, [...cleaned.keys()])));
		const keep = found.filter((tag) => {
			if (tag.removedAt) skipped.push(tag.name);
			return !tag.removedAt;
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

// Matches names against a curated list by slug. Removed entries do not
// match. Nothing is written.
export async function listedByName(
	db: Database,
	kind: ListKind,
	names: string[]
): Promise<{ ids: string[]; missing: string[] }> {
	const slugs = [...new Set(names.map(tagSlug).filter(Boolean))];
	const found =
		slugs.length === 0
			? []
			: await db
					.select({ id: tags.id, slug: tags.slug })
					.from(tags)
					.where(and(eq(tags.kind, kind), inArray(tags.slug, slugs), isNull(tags.removedAt)));
	return {
		ids: found.map((tag) => tag.id),
		missing: names.filter((name) => !found.some((tag) => tag.slug === tagSlug(name)))
	};
}

// Finds fandoms on the curated list by name. A name not on it is refused;
// authors cannot add fandoms. Nothing is written.
export async function findFandoms(
	db: Database,
	names: string[]
): Promise<{ ok: true; ids: string[] } | { ok: false; message: string }> {
	if (new Set(names.map(tagSlug).filter(Boolean)).size > MAX_FANDOMS) {
		return { ok: false, message: `A story can have up to ${MAX_FANDOMS} fandoms.` };
	}
	const { ids, missing } = await listedByName(db, 'fandom', names);
	if (missing.length > 0) {
		return {
			ok: false,
			message: `Not on the fandom list: ${missing.join(', ')}. Use a tag instead, or ask the people who run this site to add it.`
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

async function replaceStoryTags(tx: Database, storyId: string, kind: TagKind, tagIds: string[]) {
	await tx.execute(sql`
		delete from story_tags st using tags t
		where st.tag_id = t.id and st.story_id = ${storyId} and t.kind = ${kind}
	`);
	if (tagIds.length > 0) {
		await tx
			.insert(storyTags)
			.values(tagIds.map((tagId) => ({ storyId, tagId })))
			.onConflictDoNothing();
	}
}

// The current entries of a curated list, for authors to pick from.
export async function listEntries(
	db: Database,
	kind: ListKind
): Promise<{ id: string; name: string }[]> {
	return await db
		.select({ id: tags.id, name: tags.name })
		.from(tags)
		.where(and(eq(tags.kind, kind), isNull(tags.removedAt), isNull(tags.mergedIntoId)))
		.orderBy(asc(tags.name));
}

// ============ Moderation ============

const PAGE_SIZE = 50;

// The tags or fandoms with how many stories carry each directly, for the
// moderation pages. Removed ones are listed too, so they can be restored.
export async function listTagsForModeration(
	db: Database,
	kind: TagKind,
	options: { query?: string; page?: number } = {}
) {
	const page = Math.max(0, Math.floor(options.page ?? 0));
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
			uses: sql<number>`(select count(*)::int from story_tags st where st.tag_id = ${tags.id})`
		})
		.from(tags)
		.where(and(eq(tags.kind, kind), query ? ilike(tags.name, pattern(query)) : undefined))
		.orderBy(asc(tags.name))
		.limit(PAGE_SIZE + 1)
		.offset(page * PAGE_SIZE);
	return { rows: rows.slice(0, PAGE_SIZE), page, more: rows.length > PAGE_SIZE };
}

type ModResult = { ok: true } | { ok: false; message: string };

// Renames a tag or fandom. Its slug follows the new name, so a name that
// another entry of the same kind already has is refused: merge them instead.
export async function renameTag(db: Database, id: string, rawName: string): Promise<ModResult> {
	const cleaned = cleanTagName(rawName);
	if (!cleaned.ok) return { ok: false, message: cleaned.reason };
	const slug = tagSlug(cleaned.name);
	const [tag] = await db.select().from(tags).where(eq(tags.id, id));
	if (!tag) return { ok: false, message: 'That entry does not exist.' };
	const [clash] = await db
		.select({ id: tags.id })
		.from(tags)
		.where(and(eq(tags.kind, tag.kind), eq(tags.slug, slug)));
	if (clash && clash.id !== id) {
		return { ok: false, message: 'Another entry already has that name. Merge them instead.' };
	}
	await db.update(tags).set({ name: cleaned.name, slug }).where(eq(tags.id, id));
	return { ok: true };
}

// Points a tag at another of the same kind. Reads follow it, so every story
// with the source shows the target; undoing only clears the pointer.
export async function mergeTag(
	db: Database,
	sourceId: string,
	targetName: string
): Promise<ModResult> {
	return await db.transaction(async (tx) => {
		const [source] = await tx.select().from(tags).where(eq(tags.id, sourceId)).for('update');
		if (!source) return { ok: false, message: 'That entry does not exist.' };
		const [target] = await tx
			.select()
			.from(tags)
			.where(and(eq(tags.kind, source.kind), eq(tags.slug, tagSlug(targetName))));
		if (!target || target.removedAt) {
			return { ok: false, message: `There is no ${source.kind} called "${targetName.trim()}".` };
		}
		if (target.id === source.id) return { ok: false, message: 'Pick a different entry.' };
		// Refuse a merge that would loop back to the source.
		const loop = await tx.execute(sql`
			with recursive chain as (
				select id, merged_into_id, 0 as depth from tags where id = ${target.id}
				union all
				select t.id, t.merged_into_id, c.depth + 1 from chain c join tags t on t.id = c.merged_into_id
				where c.depth < ${MAX_MERGE_DEPTH}
			)
			select 1 from chain where id = ${source.id}
		`);
		if (loop.rows.length > 0) {
			return { ok: false, message: `"${target.name}" is already merged into "${source.name}".` };
		}
		await tx.update(tags).set({ mergedIntoId: target.id }).where(eq(tags.id, source.id));
		return { ok: true };
	});
}

export async function unmergeTag(db: Database, id: string): Promise<boolean> {
	const updated = await db
		.update(tags)
		.set({ mergedIntoId: null })
		.where(and(eq(tags.id, id), sql`${tags.mergedIntoId} is not null`))
		.returning({ id: tags.id });
	return updated.length > 0;
}

export async function setTagRemoved(
	db: Database,
	id: string,
	removed: boolean,
	by: string
): Promise<boolean> {
	const updated = await db
		.update(tags)
		.set(removed ? { removedAt: sql`now()`, removedBy: by } : { removedAt: null, removedBy: null })
		.where(eq(tags.id, id))
		.returning({ id: tags.id });
	return updated.length > 0;
}

// Adds entries to a curated list from a multi-line box, one name per line.
// Names already on the list (by slug, removed ones included) are skipped and
// reported.
export async function addListEntries(
	db: Database,
	kind: ListKind,
	text: string
): Promise<{ ok: true; added: string[]; skipped: string[] } | { ok: false; message: string }> {
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
	return {
		ok: true,
		added: inserted.map((row) => row.name),
		skipped: [...wanted].filter(([slug]) => !addedSlugs.has(slug)).map(([, name]) => name)
	};
}
