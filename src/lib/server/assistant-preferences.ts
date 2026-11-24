import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { isUuid } from '../slug.ts';
import { scenes, stories, universes } from './db/schema.ts';
import { storyAssistantOn, storyIsLive } from './universe-scope.ts';
import {
	effectivePreferences,
	NO_PREFERENCES,
	type PreferenceSetting,
	type StoredPreferences
} from '../assistant-preferences.ts';

// The Assistant preferences the prompts state for a piece of work, read the
// way language.ts reads the language: the callers pass ids they have already
// checked, and ownerId, where given, scopes the read too (the MCP prompts).
// A story or universe that is gone (or in a trashed universe), or not that
// owner's, reads as nothing set, and so, with assistantOn, does a story the
// Assistant is muted on.

export async function storyPreferences(
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
	if (valid(ids.storyId)) return storyPreferences(db, ids.storyId.trim(), ownerId, on);
	if (valid(ids.sceneId)) {
		const [row] = await db
			.select({ storyId: scenes.storyId })
			.from(scenes)
			.where(eq(scenes.id, ids.sceneId.trim()));
		return row ? storyPreferences(db, row.storyId, ownerId, on) : NO_PREFERENCES;
	}
	if (valid(ids.universeId)) return universePreferences(db, ids.universeId.trim(), ownerId);
	return NO_PREFERENCES;
}

// Saves the preferences form of a story or a universe the caller owns.
// Returns false when there is no such live row of theirs.
export async function savePreferences(
	db: Database,
	ownerId: string,
	target: { storyId: string } | { universeId: string },
	input: { preferences: StoredPreferences; notes: string | null }
): Promise<boolean> {
	const values = { assistantPreferences: input.preferences, assistantNotes: input.notes };
	const saved =
		'storyId' in target
			? await db
					.update(stories)
					.set(values)
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
					.set(values)
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
