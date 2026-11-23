import { error, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import type { PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import {
	publicEdition,
	publicStoryRedirect,
	publicUniverseLink,
	type EditionContent
} from '#lib/server/publish';
import { listEditionArtifacts } from '#lib/server/export-artifacts';
import { authorName } from '#lib/author-name';
import { wordCount } from '#lib/word-count';
import { isUuid } from '#lib/slug';
import { OLD_SLUG_REDIRECT_HEADERS } from '#lib/server/slugs';

// The reader view of one frozen edition, at /@handle/<story slug> or, for
// links made before slugs, /@handle/<story id>. Adult work sits behind a
// confirmation link; the page then carries noindex either way. A slug the
// story had before a rename redirects permanently to the current one.
export const load: PageServerLoad = async ({ params, url, setHeaders }) => {
	const handle = params.handle.toLowerCase();
	const ref = params.story.toLowerCase();
	const edition = await publicEdition(db, handle, ref);
	if (!edition) {
		const moved = isUuid(ref) ? null : await publicStoryRedirect(db, handle, ref);
		if (moved) {
			setHeaders(OLD_SLUG_REDIRECT_HEADERS);
			redirect(308, resolve('/@[handle]/[story=ref]', { handle, story: moved }) + url.search);
		}
		error(404, 'Not found');
	}
	// Links built here use the story's own address: the slug when it is
	// listed, the id when it is unlisted.
	const story = edition.address;

	// The reader chrome names the author: their own credit on the story if they
	// gave one, else the name on their account. Never the raw handle.
	const author = edition.author?.trim() || authorName(edition);

	const confirmed = url.searchParams.get('adult') === 'ok';
	if (edition.isAdult && !confirmed) {
		return {
			handle,
			story,
			gate: true as const,
			title: edition.title,
			author
		};
	}
	// Reader-facing downloads, only when the author switched them on. The
	// markdown zip is owner-only and never offered here.
	const downloads = edition.downloadsPublic
		? (await listEditionArtifacts(db, edition.id))
				.filter((artifact) => artifact.format !== 'markdown')
				.map((artifact) => ({ id: artifact.id, format: artifact.format }))
		: [];

	const content = edition.content as EditionContent;
	// The byline's word count, taken from the frozen prose so it matches what is
	// on the page rather than the live draft.
	const words =
		content.chapters.reduce(
			(sum, chapter) =>
				sum + chapter.scenes.reduce((chapterSum, scene) => chapterSum + wordCount(scene.bodyMd), 0),
			0
		) + content.unfiled.reduce((sum, scene) => sum + wordCount(scene.bodyMd), 0);

	// The universe's public page, when it has one (some story in it is listed
	// on the shelf). The id comes from the edition, so this never names a
	// universe the reader could not already reach.
	const universe = await publicUniverseLink(db, handle, edition.universeId);

	return {
		handle,
		story,
		gate: false as const,
		universe,
		title: edition.title,
		author,
		words,
		descriptionMd: edition.descriptionMd,
		isAdult: edition.isAdult,
		versionLabel: edition.versionLabel,
		publishedAt: edition.publishedAt,
		coverAssetId: edition.coverAssetId,
		downloads,
		content
	};
};
