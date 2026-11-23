import { eq } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { universes } from './db/schema.ts';
import { saveWithSlug } from './slugs.ts';

export type UniverseDetails = {
	name: string;
	descriptionMd: string | null;
	establishedSetting: boolean;
};

// Saves the universe settings' details form and returns the universe's slug.
// The slug follows the name: a rename moves the universe's URL, an unchanged
// name leaves it alone. See saveWithSlug for what happens to the old slug.
export async function saveUniverseDetails(
	db: Database,
	ownerId: string,
	universe: { id: string; name: string },
	details: UniverseDetails
): Promise<string> {
	const renamed = details.name !== universe.name;
	return saveWithSlug(
		db,
		'universes',
		ownerId,
		universe.id,
		renamed ? details.name : null,
		async (tx, slug) => {
			await tx
				.update(universes)
				.set({ ...details, slug })
				.where(eq(universes.id, universe.id));
		}
	);
}
