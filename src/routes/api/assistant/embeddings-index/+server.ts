import { error, type RequestHandler } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '#lib/server/db';
import { stories, universes } from '#lib/server/db/schema';
import { readAssistantPayload } from '#lib/server/llm/assistant-route';
import { resolveEmbeddings } from '#lib/server/llm/embeddings';
import {
	enableEmbeddingIndex,
	estimateEmbeddingIndex,
	removeEmbeddingIndex
} from '#lib/server/llm/embeddings/scene-index';
import { cancelEmbeddingsJobs, queueEmbeddingsIndex } from '#lib/server/jobs';
import { isUuid } from '#lib/slug';

// The search index of one universe, from the account page: the writer's own
// stories there, embedded with their embeddings model. POST turns it on and
// queues a full index (with estimate: true it only says what that would
// send); DELETE turns it off and drops what was indexed.

// The universe id, when the writer has a live story in that live universe.
async function universeOf(userId: string, raw: unknown): Promise<string> {
	const universeId = typeof raw === 'string' && isUuid(raw) ? raw : '';
	if (!universeId) error(400, 'universeId is required.');
	const [row] = await db
		.select({ id: universes.id })
		.from(universes)
		.innerJoin(stories, eq(stories.universeId, universes.id))
		.where(
			and(
				eq(universes.id, universeId),
				isNull(universes.deletedAt),
				eq(stories.ownerId, userId),
				isNull(stories.deletedAt)
			)
		)
		.limit(1);
	if (!row) error(404, 'Not found.');
	return row.id;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{
		universeId?: unknown;
		estimate?: unknown;
	}>(request, locals);
	const universeId = await universeOf(userId, payload.universeId);
	if (!(await resolveEmbeddings(db, userId)).ready) {
		error(403, 'Turn on embeddings on the Assistant page first.');
	}
	if (payload.estimate === true) {
		return Response.json(await estimateEmbeddingIndex(db, userId, { universeId }));
	}
	await enableEmbeddingIndex(db, userId, universeId);
	const jobId = await queueEmbeddingsIndex({ userId, universeId });
	if (jobId === 'coalesced') {
		error(409, 'This universe is already being indexed. It carries on; this started nothing new.');
	}
	if (!jobId) error(503, 'Could not start indexing. Try again in a moment.');
	return Response.json({ ok: true, jobId });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
	const { userId, payload } = await readAssistantPayload<{ universeId?: unknown }>(request, locals);
	const universeId = await universeOf(userId, payload.universeId);
	await cancelEmbeddingsJobs(userId, universeId);
	await removeEmbeddingIndex(db, userId, universeId);
	return Response.json({ ok: true });
};
