import { and, eq } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { stories } from './db/schema.ts';
import { saveWithSlug } from './slugs.ts';

export type StoryDetails = {
	title: string;
	author: string | null;
	brief: string | null;
	descriptionMd: string | null;
	styleNotes: string | null;
	coverColor: string | null;
};

// Saves the story settings' details form and returns the story's slug, or
// null when the story is gone. The slug follows the title: a rename moves the
// story's URL, an unchanged title leaves it alone. See saveWithSlug for what
// happens to the old slug.
export async function saveStoryDetails(
	db: Database,
	ownerId: string,
	story: { id: string },
	details: StoryDetails
): Promise<string | null> {
	return saveWithSlug(db, 'stories', story.id, details.title, async (tx, slug) => {
		await tx
			.update(stories)
			.set({ ...details, slug })
			.where(and(eq(stories.id, story.id), eq(stories.ownerId, ownerId)));
	});
}
