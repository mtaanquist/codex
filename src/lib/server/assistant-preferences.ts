import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { isUuid } from '../slug.ts';
import { scenes, stories, tags, universes } from './db/schema.ts';
import { storyAssistantOn, storyIsLive } from './universe-scope.ts';
import { mcpAccountEnabled, mcpInstanceEnabled } from './mcp/settings.ts';
import { MAX_MERGE_DEPTH } from './tags.ts';
import {
	effectivePreferences,
	limitChanges,
	NO_PREFERENCES,
	normalisePreferences,
	type LiveWarning,
	type PreferenceChanges,
	type PreferenceSetting,
	type StoredPreferences,
	WARNING_PREFIX,
	warningListFingerprint
} from '../assistant-preferences.ts';

// The Assistant preferences the prompts state for a piece of work, read the
// way language.ts reads the language: the callers pass ids they have already
// checked, and ownerId, where given, scopes the read too (the MCP prompts).
// A story or universe that is gone (or in a trashed universe), or not that
// owner's, reads as nothing set, and so, with assistantOn, does a story the
// Assistant is muted on.

// The content warnings on the admin's list as they stand, in list order: the
// switches a writer sets content limits with. Each carries the slugs of the
// warnings merged into it, directly or along a chain, whose limits it folds in
// (effectivePreferences). A warning removed drops out with its limits, and so
// do the ones merged into it.
export async function liveWarnings(db: Database): Promise<LiveWarning[]> {
	const rows = await db
		.select({
			id: tags.id,
			name: tags.name,
			slug: tags.slug,
			mergedIntoId: tags.mergedIntoId,
			removed: sql<boolean>`${tags.removedAt} is not null`
		})
		.from(tags)
		.where(eq(tags.kind, 'warning'))
		.orderBy(asc(tags.name));
	const byId = new Map(rows.map((row) => [row.id, row]));
	const live = new Map<string, LiveWarning>();
	for (const row of rows) {
		if (!row.removed && !row.mergedIntoId) {
			live.set(row.id, { id: row.id, name: row.name, slug: row.slug, merged: [] });
		}
	}
	for (const row of rows) {
		let at = row;
		for (let depth = 0; at.mergedIntoId && depth < MAX_MERGE_DEPTH; depth++) {
			const next = byId.get(at.mergedIntoId);
			if (!next) break;
			at = next;
		}
		if (at !== row && !at.mergedIntoId) live.get(at.id)?.merged.push(row.slug);
	}
	return [...live.values()];
}

export async function storyAssistantPreferences(
	db: Database,
	storyId: string,
	ownerId?: string,
	options: { assistantOn?: boolean } = {}
): Promise<PreferenceSetting> {
	const [row] = await db
		.select({
			story: stories.assistantPreferences,
			storyNotes: stories.assistantNotes,
			universe: universes.assistantPreferences,
			universeNotes: universes.assistantNotes
		})
		.from(stories)
		.innerJoin(universes, eq(stories.universeId, universes.id))
		.where(
			and(
				eq(stories.id, storyId),
				ownerId ? eq(stories.ownerId, ownerId) : undefined,
				storyIsLive(),
				options.assistantOn ? storyAssistantOn() : undefined
			)
		);
	if (!row) return NO_PREFERENCES;
	return effectivePreferences(
		{ preferences: row.story, notes: row.storyNotes },
		{ preferences: row.universe, notes: row.universeNotes },
		await liveWarnings(db)
	);
}

export async function universePreferences(
	db: Database,
	universeId: string,
	ownerId?: string
): Promise<PreferenceSetting> {
	const [row] = await db
		.select({ preferences: universes.assistantPreferences, notes: universes.assistantNotes })
		.from(universes)
		.where(
			and(
				eq(universes.id, universeId),
				ownerId ? eq(universes.ownerId, ownerId) : undefined,
				isNull(universes.deletedAt)
			)
		);
	return row ? effectivePreferences(null, row, await liveWarnings(db)) : NO_PREFERENCES;
}

// The preferences of whatever an MCP prompt names, most specific first: a
// story, else a scene's story, else a universe. Ids that are not ids, and a
// story the Assistant is muted on, read as nothing set.
export async function workPreferences(
	db: Database,
	ownerId: string,
	ids: { storyId?: unknown; sceneId?: unknown; universeId?: unknown }
): Promise<PreferenceSetting> {
	const valid = (value: unknown): value is string =>
		typeof value === 'string' && isUuid(value.trim());
	const on = { assistantOn: true };
	if (valid(ids.storyId)) return storyAssistantPreferences(db, ids.storyId.trim(), ownerId, on);
	if (valid(ids.sceneId)) {
		const [row] = await db
			.select({ storyId: scenes.storyId })
			.from(scenes)
			.where(and(eq(scenes.id, ids.sceneId.trim()), isNull(scenes.deletedAt)));
		return row ? storyAssistantPreferences(db, row.storyId, ownerId, on) : NO_PREFERENCES;
	}
	if (valid(ids.universeId)) return universePreferences(db, ids.universeId.trim(), ownerId);
	return NO_PREFERENCES;
}

// A story's stored preferences, read inside a transaction that copies them
// to a new row: the warnings its limits name are share-locked first, so a
// rename (which updates the warning, then moves the limits on every row it
// can see) either finishes before the read or waits until the copy commits
// and then moves the copy's limits too. Read again until every slug read is
// locked, in case a rename moved one in between.
export async function storyPreferencesForCopy(tx: Database, storyId: string): Promise<unknown> {
	const locked = new Set<string>();
	for (;;) {
		const [row] = await tx
			.select({ preferences: stories.assistantPreferences })
			.from(stories)
			.where(eq(stories.id, storyId));
		const preferences = row?.preferences ?? {};
		const slugs = Object.keys(preferences as Record<string, unknown>)
			.filter((key) => key.startsWith(WARNING_PREFIX))
			.map((key) => key.slice(WARNING_PREFIX.length))
			.filter((slug) => !locked.has(slug));
		if (slugs.length === 0) return preferences;
		await tx
			.select({ id: tags.id })
			.from(tags)
			.where(and(eq(tags.kind, 'warning'), inArray(tags.slug, slugs)))
			.orderBy(asc(tags.id))
			.for('share');
		for (const slug of slugs) locked.add(slug);
	}
}

// Preferences from an import with the content limits this site cannot use
// taken out: a limit on a slug that is neither a live warning nor merged into
// one would never apply, and would come back to life if a warning by that
// name were added later. Inside a transaction the warnings the limits name
// are share-locked first, as in savePreferences.
export async function usableContentLimits(
	db: Database,
	preferences: StoredPreferences
): Promise<{ preferences: StoredPreferences; dropped: number }> {
	const slugs = Object.keys(preferences)
		.filter((key) => key.startsWith(WARNING_PREFIX))
		.map((key) => key.slice(WARNING_PREFIX.length));
	if (slugs.length === 0) return { preferences, dropped: 0 };
	await db
		.select({ id: tags.id })
		.from(tags)
		.where(and(eq(tags.kind, 'warning'), inArray(tags.slug, slugs)))
		.orderBy(asc(tags.id))
		.for('share');
	const usable = new Set(
		(await liveWarnings(db)).flatMap((warning) => [warning.slug, ...warning.merged])
	);
	const kept = Object.fromEntries(
		Object.entries(preferences).filter(
			([key]) => !key.startsWith(WARNING_PREFIX) || usable.has(key.slice(WARNING_PREFIX.length))
		)
	) as StoredPreferences;
	return { preferences: kept, dropped: slugs.filter((slug) => !usable.has(slug)).length };
}

// The import notice for limits usableContentLimits took out.
export function droppedLimitsProblem(dropped: number): string {
	return dropped === 1
		? "story.md: one Assistant content limit is for a content warning this site's list does not have, so it was left off."
		: `story.md: ${dropped} Assistant content limits are for content warnings this site's list does not have, so they were left off.`;
}

// Whether the settings pages show the preferences form: wherever the
// preferences reach a prompt, so with the Assistant tab on (tabEnabled, from
// assistantLayout) or with connected apps switched on for the account.
export async function assistantPreferencesShown(
	db: Database,
	userId: string,
	tabEnabled: boolean
): Promise<boolean> {
	if (tabEnabled) return true;
	return (await mcpInstanceEnabled(db)) && (await mcpAccountEnabled(db, userId));
}

// The stored object with the form's changes merged over it: a value set, a
// null removed, a key the form did not carry left as it was. Done in one
// statement so two saves of different keys cannot undo each other.
function mergedPreferences(
	column: typeof stories.assistantPreferences | typeof universes.assistantPreferences,
	changes: PreferenceChanges
): SQL {
	const set = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== null));
	const cleared = Object.keys(changes).filter((key) => !(key in set));
	const merged = sql`(${column} || ${JSON.stringify(set)}::jsonb)`;
	if (cleared.length === 0) return merged;
	const keys = sql.join(
		cleared.map((key) => sql`${key}`),
		sql`, `
	);
	return sql`(${merged} - array[${keys}]::text[])`;
}

// The notice an outdated form's save answers with (see readPreferencesForm).
export const OUTDATED_WARNINGS =
	'Your other changes are saved. The list of content warnings has changed, so your content limits were not changed. Reload the page to set them.';

// Saves the preferences form of a story or a universe the caller owns:
// 'missing' when there is no such live row of theirs. Notes left undefined
// (the post did not carry the field) are kept. The form posts only the limits
// the writer changed, with the warning list it was built from (warningList,
// see warningListFingerprint). Those limits are checked against the live
// warnings read after a share lock on the posted slugs' rows and the lock on
// the row being saved: when the list differs from the form's, or a posted
// slug is no longer live, no limit is changed ('outdated'), so a limit is
// never stored against a list the writer did not see. The share lock holds
// off a rename, removal or merge of a posted warning and a merge into or out
// of one (mergeTag and unmergeTag lock the survivor too); a change to another
// warning does not alter a posted warning's fold. The tag lock comes first,
// then the row's, the order a rename (its tag row, then the limits it moves)
// and an undone merge take them in, so none of them deadlock: a rename of a
// posted warning has landed before this save reads the row and the list, or
// waits for it.
//
// The form shows each warning's limit folded with the ones merged into it, so
// a limit is compared with that and, where the writer changed it, replaces
// this row's limits on the merged warnings too (limitChanges).
export async function savePreferences(
	db: Database,
	ownerId: string,
	target: { storyId: string } | { universeId: string },
	input: {
		changes: PreferenceChanges;
		notes: string | null | undefined;
		warningList?: string;
	}
): Promise<'saved' | 'missing' | 'outdated'> {
	const notes = input.notes === undefined ? {} : { assistantNotes: input.notes };
	const table = 'storyId' in target ? stories : universes;
	const owned = and(
		'storyId' in target ? eq(stories.id, target.storyId) : eq(universes.id, target.universeId),
		eq(table.ownerId, ownerId),
		isNull(table.deletedAt)
	);
	return db.transaction(async (tx) => {
		let changes = input.changes;
		let outdated = false;
		const limitSlugs = Object.keys(changes)
			.filter((key) => key.startsWith(WARNING_PREFIX))
			.map((key) => key.slice(WARNING_PREFIX.length));
		if (limitSlugs.length > 0) {
			await tx
				.select({ id: tags.id })
				.from(tags)
				.where(and(eq(tags.kind, 'warning'), inArray(tags.slug, limitSlugs)))
				.orderBy(asc(tags.id))
				.for('share');
			const [row] = await tx
				.select({ preferences: table.assistantPreferences })
				.from(table)
				.where(owned)
				.for('update');
			if (!row) return 'missing';
			const warnings = await liveWarnings(tx);
			const live = new Set(warnings.map(({ slug }) => slug));
			outdated =
				input.warningList !== warningListFingerprint(warnings) ||
				limitSlugs.some((slug) => !live.has(slug));
			changes = outdated
				? (Object.fromEntries(
						Object.entries(changes).filter(([key]) => !key.startsWith(WARNING_PREFIX))
					) as PreferenceChanges)
				: limitChanges(changes, normalisePreferences(row.preferences), warnings);
		}
		const saved = await tx
			.update(table)
			.set({
				assistantPreferences: mergedPreferences(table.assistantPreferences, changes),
				...notes
			})
			.where(owned)
			.returning({ id: table.id });
		if (saved.length === 0) return 'missing';
		return outdated ? 'outdated' : 'saved';
	});
}
