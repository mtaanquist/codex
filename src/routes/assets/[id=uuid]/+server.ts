import { error } from '@sveltejs/kit';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { assets } from '#lib/server/db/schema';
import { effectiveAssetConfig, getObjectOrNull, openAsset, s3AssetStore } from '#lib/server/assets';
import { isPublicAsset, isPublicAvatar, moderatorMayReadAsset } from '#lib/server/publish';
import { canModerate } from '#lib/roles';
import { ASSETS_OFF_MESSAGE } from '#lib/server/asset-storage-message';

// Streams an uploaded asset: to its owner always, to anyone when it belongs
// to a publicly readable edition (cover or inline image), and to a moderator
// when it is an inline image of an edition they may read on its moderation
// page, also one that is down.
export const GET: RequestHandler = async ({ params, locals }) => {
	const config = await effectiveAssetConfig(db);
	if (!config) error(503, ASSETS_OFF_MESSAGE);
	const store = s3AssetStore(config);

	let opened = locals.user ? await openAsset(db, store, locals.user.id, params.id) : null;
	let access: 'owner' | 'public' | 'moderator' = 'owner';
	if (!opened) {
		if ((await isPublicAsset(db, params.id)) || (await isPublicAvatar(db, params.id))) {
			access = 'public';
		} else if (canModerate(locals.user?.role) && (await moderatorMayReadAsset(db, params.id))) {
			access = 'moderator';
		}
		if (access !== 'owner') {
			const [row] = await db.select().from(assets).where(eq(assets.id, params.id));
			const body = row ? await getObjectOrNull(store, row.storageKey) : null;
			if (row && body) opened = { asset: row, body };
		}
	}
	if (!opened) error(404, 'asset not found');

	// The bytes never change, but public reachability does (takedown,
	// visibility flip), and the URL is keyed only by id. So the owner's
	// own request caches hard, while the public copy revalidates quickly
	// enough that a takedown is not defeated by a year-long cache. A
	// moderator's copy is not kept: their access ends with their role.
	const cacheControl = {
		owner: 'private, max-age=31536000, immutable',
		public: 'public, max-age=300, must-revalidate',
		moderator: 'private, no-store'
	}[access];

	return new Response(Readable.toWeb(opened.body) as ReadableStream, {
		headers: {
			'content-type': opened.asset.contentType,
			'content-length': String(opened.asset.byteSize),
			'cache-control': cacheControl,
			'x-content-type-options': 'nosniff'
		}
	});
};
