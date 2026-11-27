import { error, type RequestHandler } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import { readAssistantPayload } from '#lib/server/llm/assistant-route';
import { EmbeddingsDisabledError } from '#lib/server/llm/embeddings';
import { SpendCapError } from '#lib/server/llm/spend';
import { errorFields, logEvent } from '#lib/server/log';
import { rateLimit } from '#lib/server/rate-limit';
import { MEANING_QUERY_MAX, meaningSearchReady, searchByMeaning } from '#lib/server/search-meaning';
import { ownedStory } from '#lib/server/story-access';
import { ownedUniverse } from '#lib/server/universe-access';
import { isUuid } from '#lib/slug';

// The command palette's "By meaning" mode, for the universe of the page it
// was opened on. GET says whether that universe can be searched this way
// (?story= or ?universe=, an id or slug); POST runs one search. Only POST
// sends anything to a model, so the palette calls it on Enter, never as the
// writer types.

export const GET: RequestHandler = async ({ url, locals }) => {
	const userId = locals.user!.id;
	if (!rateLimit(`search:${userId}`, 120, 60 * 1000).allowed) {
		return Response.json({ universeId: null });
	}
	const storyRef = url.searchParams.get('story');
	const universeRef = url.searchParams.get('universe');
	let universeId: string;
	if (storyRef) universeId = (await ownedStory(storyRef, userId)).universe.id;
	else if (universeRef) universeId = (await ownedUniverse(universeRef, userId)).id;
	else error(400, 'story or universe is required.');
	const ready = await meaningSearchReady(db, userId, universeId);
	return Response.json({ universeId: ready ? universeId : null });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	// The Assistant's rate limit: each search is a paid request.
	const { userId, payload } = await readAssistantPayload<{
		universeId?: unknown;
		query?: unknown;
	}>(request, locals);
	const universeId = typeof payload.universeId === 'string' ? payload.universeId : '';
	if (!isUuid(universeId)) error(400, 'universeId is required.');
	const query = typeof payload.query === 'string' ? payload.query.trim() : '';
	if (!query) error(400, 'Describe what you are looking for.');
	if (query.length > MEANING_QUERY_MAX) {
		error(400, `Keep the description under ${MEANING_QUERY_MAX} characters.`);
	}
	if (!(await meaningSearchReady(db, userId, universeId))) {
		error(404, 'This universe has no search index. Index it from your account Assistant page.');
	}
	try {
		return Response.json({ results: await searchByMeaning(db, userId, universeId, query) });
	} catch (err) {
		if (err instanceof EmbeddingsDisabledError) {
			error(403, 'Embeddings are off. Turn them on from your account Assistant page.');
		}
		if (err instanceof SpendCapError) {
			error(403, 'This search could take you past your spend cap, so it was not sent.');
		}
		logEvent('warn', 'search.meaning_failed', { userId, ...errorFields(err) });
		error(
			502,
			'Your embeddings model could not be reached. Try again, or check it with Test connection on your account Assistant page.'
		);
	}
};
