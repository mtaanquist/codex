import { eq } from 'drizzle-orm';
import type { Database } from './auth';
import {
	entityTable,
	resolveOwnedEntity,
	type EntityTable,
	type EntityType
} from './entity-lookups';
import { createAsset, type AssetConfig, type AssetObjectStore } from './assets';
import { isCategoryColor } from '#lib/entity-color';
import type { ActionFailure } from './action-result';

// The per-entity badge: a palette colour, or an uploaded image (the image
// wins). Both live on the entity row. These helpers resolve an entity id to
// whichever of the three tables holds it, owner-scoped, and update it; the
// image path mirrors the avatar flow (create, swap the reference, leave the
// old for the unused image sweep). Entities are only ever removed by the
// universe purge, which leaves their images to that sweep as well, so there
// is no per-entity asset cleanup here.

async function updateBadge(
	db: Database,
	type: EntityType,
	entityId: string,
	patch: { badgeColor?: string | null; badgeAssetId?: string | null }
): Promise<void> {
	const table = entityTable(type);
	await db.update(table).set(patch).where(eq(table.id, entityId));
}

const badgeColumns = (table: EntityTable) => ({
	universeId: table.universeId,
	badgeAssetId: table.badgeAssetId
});

export type BadgeResult = { ok: true } | ActionFailure;

const ENTRY_NOT_FOUND: ActionFailure = {
	ok: false,
	code: 'not_found',
	reason: 'This entry no longer exists. Reload the page.'
};

// Sets (or clears, with null) the entity's badge colour. A colour and an
// uploaded image are independent on the row; the image just renders on top.
export async function setEntityBadgeColor(
	db: Database,
	userId: string,
	entityId: string,
	color: string | null
): Promise<BadgeResult> {
	if (!isCategoryColor(color))
		return { ok: false, code: 'invalid', reason: 'Pick one of the colours in the menu.' };
	const ref = await resolveOwnedEntity(db, userId, entityId, badgeColumns);
	if (!ref) return ENTRY_NOT_FOUND;
	await updateBadge(db, ref.type, entityId, { badgeColor: color });
	return { ok: true };
}

// Uploads a badge image and points the entity at it. The old one is left for
// the unused image sweep, which frees it once nothing else shows it.
export async function setEntityBadgeImage(
	db: Database,
	store: AssetObjectStore,
	config: AssetConfig,
	userId: string,
	entityId: string,
	input: { filename: string; contentType: string; bytes: Buffer }
): Promise<{ ok: true; id: string } | ActionFailure> {
	const ref = await resolveOwnedEntity(db, userId, entityId, badgeColumns);
	if (!ref) return ENTRY_NOT_FOUND;
	const created = await createAsset(db, store, config, userId, {
		universeId: ref.universeId,
		kind: 'badge',
		filename: input.filename,
		contentType: input.contentType,
		bytes: input.bytes,
		replaces: ref.badgeAssetId
	});
	if (!created.ok) return created;
	await updateBadge(db, ref.type, entityId, { badgeAssetId: created.id });
	return { ok: true, id: created.id };
}

// Clears the entity's badge image, leaving it for the unused image sweep.
export async function clearEntityBadgeImage(
	db: Database,
	userId: string,
	entityId: string
): Promise<BadgeResult> {
	const ref = await resolveOwnedEntity(db, userId, entityId, badgeColumns);
	if (!ref) return ENTRY_NOT_FOUND;
	if (ref.badgeAssetId) await updateBadge(db, ref.type, entityId, { badgeAssetId: null });
	return { ok: true };
}
