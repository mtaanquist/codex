import { eq } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { isUniqueViolation } from './db-errors.ts';
import { universes } from './db/schema.ts';
import { retireSlug, uniqueSlug } from './slugs.ts';

export type UniverseDetails = {
	name: string;
	descriptionMd: string | null;
	establishedSetting: boolean;
};

// Saves the universe settings' details form and returns the universe's slug.
// The slug follows the name: a rename moves the universe's URL, an unchanged
// name leaves it alone. The slug it moves off is kept as history, so a public
// link to the old address redirects (see slug_history).
export async function saveUniverseDetails(
	db: Database,
	ownerId: string,
	universe: { id: string; name: string; slug: string },
	details: UniverseDetails
): Promise<string> {
	const save = (slug: string) =>
		db.transaction(async (tx) => {
			await tx
				.update(universes)
				.set({ ...details, slug })
				.where(eq(universes.id, universe.id));
			await retireSlug(tx, 'universes', ownerId, universe.id, universe.slug, slug);
			return slug;
		});
	const freshSlug = () =>
		uniqueSlug(db, 'universes', ownerId, details.name, 'universe', universe.id);
	try {
		return await save(details.name === universe.name ? universe.slug : await freshSlug());
	} catch (err) {
		// A concurrent create took the slug between the pick and the update.
		if (!isUniqueViolation(err)) throw err;
		return await save(await freshSlug());
	}
}
