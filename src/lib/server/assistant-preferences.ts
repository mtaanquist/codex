import { and, asc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { isUuid } from '../slug.ts';
import { scenes, stories, tags, universes } from './db/schema.ts';
import { storyAssistantOn, storyIsLive } from './universe-scope.ts';
import { mcpAccountEnabled, mcpInstanceEnabled } from './mcp/settings.ts';
import { MAX_MERGE_DEPTH } from './tags.ts';
import {
	effectivePreferences,
	NO_PREFERENCES,
	type LiveWarning,
	type PreferenceChanges,
	type PreferenceSetting,
	WARNING_PREFIX
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
// (the post did not carry the field) are kept. Content limits are checked
// again against the live warnings, under a share lock on them, so a limit
// saved while an admin renames or merges its warning is either moved by the
// rename or left out ('outdated'), never stored under a slug that no longer
// applies. Locking only the posted slugs' rows is enough: a rename updates
// the row it renames.
export async function savePreferences(
	db: Database,
	ownerId: string,
	target: { storyId: string } | { universeId: string },
	input: { changes: PreferenceChanges; notes: string | null | undefined }
): Promise<'saved' | 'missing' | 'outdated'> {
	const notes = input.notes === undefined ? {} : { assistantNotes: input.notes };
	const table = 'storyId' in target ? stories : universes;
	return db.transaction(async (tx) => {
		let changes = input.changes;
		let outdated = false;
		const limitKeys = Object.keys(changes).filter((key) => key.startsWith(WARNING_PREFIX));
		if (limitKeys.length > 0) {
			// A warning merged into another still counts (its limits fold into
			// the survivor); one renamed away or removed outright does not.
			const live = new Set(
				(
					await tx
						.select({ slug: tags.slug })
						.from(tags)
						.where(
							and(
								eq(tags.kind, 'warning'),
								inArray(
									tags.slug,
									limitKeys.map((key) => key.slice(WARNING_PREFIX.length))
								),
								or(isNull(tags.removedAt), isNotNull(tags.mergedIntoId))
							)
						)
						.for('share')
				).map(({ slug }) => slug)
			);
			outdated = limitKeys.some((key) => !live.has(key.slice(WARNING_PREFIX.length)));
			if (outdated) {
				changes = Object.fromEntries(
					Object.entries(changes).filter(([key]) => !key.startsWith(WARNING_PREFIX))
				) as PreferenceChanges;
			}
		}
		const saved = await tx
			.update(table)
			.set({
				assistantPreferences: mergedPreferences(table.assistantPreferences, changes),
				...notes
			})
			.where(
				and(
					'storyId' in target
						? eq(stories.id, target.storyId)
						: eq(universes.id, target.universeId),
					eq(table.ownerId, ownerId),
					isNull(table.deletedAt)
				)
			)
			.returning({ id: table.id });
		if (saved.length === 0) return 'missing';
		return outdated ? 'outdated' : 'saved';
	});
}
