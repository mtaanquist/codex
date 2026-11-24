import { and, eq } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { stories } from './db/schema.ts';
import { saveWithSlug } from './slugs.ts';
import type { WritingLanguage } from '../writing-languages.ts';

export type StoryDetails = {
	title: string;
	author: string | null;
	brief: string | null;
	descriptionMd: string | null;
	styleNotes: string | null;
	coverColor: string | null;
	// A tag from #lib/writing-languages, or null to use the universe's; left
	// out, unchanged.
	language?: WritingLanguage | null;
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
	return saveWithSlug(db, 'stories', ownerId, story.id, details.title, async (tx, slug) => {
		await tx
			.update(stories)
			.set({ ...details, slug })
			.where(and(eq(stories.id, story.id), eq(stories.ownerId, ownerId)));
	});
}
