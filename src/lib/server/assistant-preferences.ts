import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { isUuid } from '../slug.ts';
import { scenes, stories, universes } from './db/schema.ts';
import { storyAssistantOn, storyIsLive } from './universe-scope.ts';
import { mcpAccountEnabled, mcpInstanceEnabled } from './mcp/settings.ts';
import {
	effectivePreferences,
	NO_PREFERENCES,
	type PreferenceChanges,
	type PreferenceSetting
} from '../assistant-preferences.ts';

// The Assistant preferences the prompts state for a piece of work, read the
// way language.ts reads the language: the callers pass ids they have already
// checked, and ownerId, where given, scopes the read too (the MCP prompts).
// A story or universe that is gone (or in a trashed universe), or not that
// owner's, reads as nothing set, and so, with assistantOn, does a story the
// Assistant is muted on.

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
		{ preferences: row.universe, notes: row.universeNotes }
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
	return row ? effectivePreferences(null, row) : NO_PREFERENCES;
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

// Saves the preferences form of a story or a universe the caller owns.
// Returns false when there is no such live row of theirs. Notes left
// undefined (the post did not carry the field) are kept.
export async function savePreferences(
	db: Database,
	ownerId: string,
	target: { storyId: string } | { universeId: string },
	input: { changes: PreferenceChanges; notes: string | null | undefined }
): Promise<boolean> {
	const notes = input.notes === undefined ? {} : { assistantNotes: input.notes };
	const saved =
		'storyId' in target
			? await db
					.update(stories)
					.set({
						assistantPreferences: mergedPreferences(stories.assistantPreferences, input.changes),
						...notes
					})
					.where(
						and(
							eq(stories.id, target.storyId),
							eq(stories.ownerId, ownerId),
							isNull(stories.deletedAt)
						)
					)
					.returning({ id: stories.id })
			: await db
					.update(universes)
					.set({
						assistantPreferences: mergedPreferences(universes.assistantPreferences, input.changes),
						...notes
					})
					.where(
						and(
							eq(universes.id, target.universeId),
							eq(universes.ownerId, ownerId),
							isNull(universes.deletedAt)
						)
					)
					.returning({ id: universes.id });
	return saved.length > 0;
}
