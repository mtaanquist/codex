import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { isUuid } from '../slug.ts';
import { scenes, stories, universes, users } from './db/schema.ts';
import { storyAssistantOn, storyIsLive } from './universe-scope.ts';
import {
	effectiveLanguage,
	NO_LANGUAGE,
	normaliseLanguage,
	type LanguageSetting
} from '../writing-languages.ts';

// The language settings the Assistant's prompts state for a piece of work:
// the effective language of the story (its own, else its universe's) or of
// the universe, and the owner's native language. The callers pass ids they
// have already checked; ownerId, where given, scopes the read too (the MCP
// prompts, which check nothing else). A story or universe that is gone (or
// in a trashed universe), or not that owner's, reads as nothing set, and so,
// with assistantOn, does a story the Assistant is muted on.

export async function storyLanguage(
	db: Database,
	storyId: string,
	ownerId?: string,
	options: { assistantOn?: boolean } = {}
): Promise<LanguageSetting> {
	const [row] = await db
		.select({ story: stories.language, universe: universes.language, native: users.nativeLanguage })
		.from(stories)
		.innerJoin(universes, eq(stories.universeId, universes.id))
		.innerJoin(users, eq(stories.ownerId, users.id))
		.where(
			and(
				eq(stories.id, storyId),
				ownerId ? eq(stories.ownerId, ownerId) : undefined,
				storyIsLive(),
				options.assistantOn ? storyAssistantOn() : undefined
			)
		);
	if (!row) return NO_LANGUAGE;
	return {
		language: effectiveLanguage(row.story, row.universe),
		native: normaliseLanguage(row.native)
	};
}

export async function universeLanguage(
	db: Database,
	universeId: string,
	ownerId?: string
): Promise<LanguageSetting> {
	const [row] = await db
		.select({ universe: universes.language, native: users.nativeLanguage })
		.from(universes)
		.innerJoin(users, eq(universes.ownerId, users.id))
		.where(
			and(
				eq(universes.id, universeId),
				ownerId ? eq(universes.ownerId, ownerId) : undefined,
				isNull(universes.deletedAt)
			)
		);
	if (!row) return NO_LANGUAGE;
	return { language: normaliseLanguage(row.universe), native: normaliseLanguage(row.native) };
}

// The story of a scene, for the callers that hold only a scene id. A
// trashed scene reads as nothing set.
export async function sceneLanguage(
	db: Database,
	sceneId: string,
	ownerId?: string,
	options: { assistantOn?: boolean } = {}
): Promise<LanguageSetting> {
	const [row] = await db
		.select({ storyId: scenes.storyId })
		.from(scenes)
		.where(and(eq(scenes.id, sceneId), isNull(scenes.deletedAt)));
	return row ? storyLanguage(db, row.storyId, ownerId, options) : NO_LANGUAGE;
}

// The language of whatever a request names, most specific first: a story,
// else a scene's story, else a universe. Ids that are not ids, and a story
// the Assistant is muted on, read as nothing set. For the MCP prompts, whose
// arguments are unchecked text.
export async function workLanguage(
	db: Database,
	ownerId: string,
	ids: { storyId?: unknown; sceneId?: unknown; universeId?: unknown }
): Promise<LanguageSetting> {
	const valid = (value: unknown): value is string =>
		typeof value === 'string' && isUuid(value.trim());
	const on = { assistantOn: true };
	if (valid(ids.storyId)) return storyLanguage(db, ids.storyId.trim(), ownerId, on);
	if (valid(ids.sceneId)) return sceneLanguage(db, ids.sceneId.trim(), ownerId, on);
	if (valid(ids.universeId)) return universeLanguage(db, ids.universeId.trim(), ownerId);
	return NO_LANGUAGE;
}
