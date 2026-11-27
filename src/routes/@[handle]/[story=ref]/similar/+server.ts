import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { browseEnabled } from '#lib/server/settings';
import { similarStories } from '#lib/server/browse';
import { publicEdition } from '#lib/server/publish';
import { rateLimit } from '#lib/server/rate-limit';

const REQUESTS_PER_MINUTE = 120;

// The similar stories under a reading page, for a reader who chose to include
// adult work in Browse on this device. The server cannot read that choice, so
// the page asks here with adult=show once it has loaded.
export const GET: RequestHandler = async ({ params, url, getClientAddress, setHeaders }) => {
	if (!(await browseEnabled(db))) error(404, 'Not found');
	const limit = rateLimit(`similar:${getClientAddress()}`, REQUESTS_PER_MINUTE, 60_000);
	if (!limit.allowed) {
		setHeaders({ 'retry-after': String(limit.retryAfterSeconds) });
		error(429, 'Too many requests just now. Wait a minute and try again.');
	}
	const edition = await publicEdition(db, params.handle.toLowerCase(), params.story.toLowerCase());
	if (!edition) error(404, 'Not found');
	const adult = url.searchParams.get('adult') === 'show';
	return json({ books: await similarStories(db, edition.storyId, { adult }) });
};
