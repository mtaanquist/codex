import { and, eq } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { universes } from './db/schema.ts';
import { saveWithSlug } from './slugs.ts';

export type UniverseDetails = {
	name: string;
	descriptionMd: string | null;
	establishedSetting: boolean;
};

// Saves the universe settings' details form and returns the universe's slug,
// or null when the universe is gone. The slug follows the name: a rename
// moves the universe's URL, an unchanged name leaves it alone. See
// saveWithSlug for what happens to the old slug.
export async function saveUniverseDetails(
	db: Database,
	ownerId: string,
	universe: { id: string },
	details: UniverseDetails
): Promise<string | null> {
	return saveWithSlug(db, 'universes', ownerId, universe.id, details.name, async (tx, slug) => {
		await tx
			.update(universes)
			.set({ ...details, slug })
			.where(and(eq(universes.id, universe.id), eq(universes.ownerId, ownerId)));
	});
}
