import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { suggestFandoms } from '#lib/server/tags';
import { rateLimit } from '#lib/server/rate-limit';

// Fandom suggestions for the universe name box, while the writer types.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!rateLimit(`fandoms:${locals.user!.id}`, 120, 60 * 1000).allowed) {
		return Response.json({ results: [] });
	}
	return Response.json({ results: await suggestFandoms(db, url.searchParams.get('q') ?? '') });
};
