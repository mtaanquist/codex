import { and, desc, eq, exists, inArray, isNull, ne, sql, type AnyColumn } from 'drizzle-orm';
import type { Database } from './auth.ts';
import {
	assets,
	publicationAssets,
	publications,
	slugHistory,
	stories,
	universes,
	users
} from './db/schema.ts';
import { gatherStory, type ExportScene } from './export.ts';
import { getDraft } from './story-drafts.ts';
import { findAssetReferences } from '#lib/markdown';
import { storyCoverColor } from '#lib/entity-color';
import { isUniqueViolation } from './db-errors.ts';
import { storyIsLive } from './universe-scope.ts';
import { isUuid, readingAddress } from '#lib/slug';

// Publishing freezes the story's current prose into an edition; the
// public reading pages serve only these snapshots, never live drafts.

// The author given by the owner column is not suspended. A suspended author's
// public pages and files answer as not found until the suspension is lifted.
export const authorNotSuspended = (owner: AnyColumn) =>
	sql`not exists (select 1 from users su where su.id = ${owner} and su.suspended_at is not null)`;

export type EditionContent = {
	chapters: { title: string | null; scenes: { title: string | null; bodyMd: string }[] }[];
	unfiled: { title: string | null; bodyMd: string }[];
};

export async function publishStory(
	db: Database,
	userId: string,
	storyId: string,
	versionLabel?: string,
	// Publish a saved draft's frozen prose instead of the working draft.
	draftId?: string | null
): Promise<{ ok: true; publicationId: string } | { ok: false; reason: string }> {
	const [user] = await db
		.select({ handle: users.handle, enabled: users.publicArchiveEnabled })
		.from(users)
		.where(eq(users.id, userId));
	if (!user?.enabled) {
		return { ok: false, reason: 'The site admin has not turned on your public archive yet.' };
	}
	if (!user.handle)
		return { ok: false, reason: 'Claim a public handle on your account page first.' };
	const [story] = await db
		.select()
		.from(stories)
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId), storyIsLive()));
	if (!story) return { ok: false, reason: 'That story no longer exists.' };

	// The title, pen name and description go out as they were in the draft,
	// alongside its prose; the adult flag is the author's current choice.
	let source: { chapters: { id: string; title: string | null }[]; scenes: ExportScene[] };
	let frontMatter = {
		title: story.title,
		author: story.author,
		descriptionMd: story.descriptionMd
	};
	if (draftId) {
		const draft = await getDraft(db, story.id, draftId);
		if (!draft) return { ok: false, reason: 'That saved draft no longer exists.' };
		source = draft.content;
		frontMatter = {
			title: draft.content.story.title,
			author: draft.content.story.author,
			descriptionMd: draft.content.story.descriptionMd
		};
	} else {
		source = await gatherStory(db, story);
	}
	const known = new Set(source.chapters.map((chapter) => chapter.id));
	const content: EditionContent = {
		chapters: source.chapters
			.map((chapter) => ({
				title: chapter.title,
				scenes: source.scenes
					.filter((scene) => scene.chapterId === chapter.id)
					.map((scene) => ({ title: scene.title, bodyMd: scene.bodyMd }))
			}))
			.filter((chapter) => chapter.scenes.length > 0),
		unfiled: source.scenes
			.filter((scene) => scene.chapterId === null || !known.has(scene.chapterId))
			.map((scene) => ({ title: scene.title, bodyMd: scene.bodyMd }))
	};
	if (content.chapters.length === 0 && content.unfiled.length === 0) {
		return { ok: false, reason: 'There is nothing to publish yet.' };
	}

	// Inline images the frozen prose points at, so the reader can serve them
	// to anonymous visitors without exposing every asset by id. Only the
	// author's own existing assets: prose can name any id, including another
	// user's private image or one that does not exist on this instance.
	const mentionedAssets = [
		...new Set([
			...content.chapters.flatMap((chapter) =>
				chapter.scenes.flatMap((scene) => findAssetReferences(scene.bodyMd))
			),
			...content.unfiled.flatMap((scene) => findAssetReferences(scene.bodyMd))
		])
	];
	try {
		const publicationId = await db.transaction(async (tx) => {
			await tx
				.update(publications)
				.set({ isCurrent: false })
				.where(and(eq(publications.storyId, story.id), eq(publications.isCurrent, true)));
			const [edition] = await tx
				.insert(publications)
				.values({
					storyId: story.id,
					ownerId: userId,
					handle: user.handle!,
					...frontMatter,
					isAdult: story.isAdult,
					content,
					versionLabel: versionLabel?.trim() || null,
					sourceDraftId: draftId || null
				})
				.returning({ id: publications.id });
			// Locked so a concurrent delete of one of these images cannot slip
			// in before the link is written.
			const referencedAssets =
				mentionedAssets.length === 0
					? []
					: (
							await tx
								.select({ id: assets.id })
								.from(assets)
								.where(and(inArray(assets.id, mentionedAssets), eq(assets.ownerId, userId)))
								.for('share')
						).map((row) => row.id);
			if (referencedAssets.length > 0) {
				await tx
					.insert(publicationAssets)
					.values(referencedAssets.map((assetId) => ({ publicationId: edition.id, assetId })));
			}
			return edition.id;
		});
		return { ok: true, publicationId };
	} catch (error) {
		// The partial unique index caught a concurrent publish of the same
		// story; the loser rolls back rather than leaving two current rows.
		if (isUniqueViolation(error)) {
			return { ok: false, reason: 'Another publish just finished. Reload the page and try again.' };
		}
		throw error;
	}
}

// The story's public reading page, for the story menu in the app bar. Null
// unless the story has a current, non-removed edition under a handle, so the
// menu leaves the item out rather than offering a link that 404s. The
// address is the slug for a public story and the id for an unlisted one
// (see readingAddress).
export async function readingPageRef(
	db: Database,
	storyId: string
): Promise<{ handle: string; story: string } | null> {
	const [row] = await db
		.select({
			handle: publications.handle,
			id: stories.id,
			slug: stories.slug,
			visibility: stories.visibility
		})
		.from(publications)
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.where(
			and(
				eq(publications.storyId, storyId),
				eq(publications.isCurrent, true),
				isNull(publications.removedAt),
				storyIsLive(),
				ne(stories.visibility, 'private'),
				authorNotSuspended(publications.ownerId)
			)
		);
	return row ? { handle: row.handle, story: readingAddress(row) } : null;
}

// The author shelf: current, non-removed editions of stories the author
// has set public. Unlisted stories stay reachable by direct link only. With
// a universe id, only that universe's stories: the public universe page.
export async function publicShelf(db: Database, handle: string, universeId?: string) {
	const rows = await db
		.select({
			storyId: publications.storyId,
			slug: stories.slug,
			title: publications.title,
			author: publications.author,
			descriptionMd: publications.descriptionMd,
			isAdult: publications.isAdult,
			publishedAt: publications.publishedAt,
			coverAssetId: stories.coverAssetId,
			coverColor: stories.coverColor
		})
		.from(publications)
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.where(
			and(
				eq(publications.handle, handle),
				eq(stories.ownerId, publications.ownerId),
				universeId ? eq(stories.universeId, universeId) : undefined,
				eq(publications.isCurrent, true),
				isNull(publications.removedAt),
				storyIsLive(),
				eq(stories.visibility, 'public'),
				authorNotSuspended(publications.ownerId)
			)
		)
		.orderBy(desc(publications.publishedAt));
	return rows.map((row) => ({
		...row,
		coverColor: storyCoverColor({ id: row.storyId, coverColor: row.coverColor })
	}));
}

// The author's public profile for the shelf header: identity, bio, links, and
// commissions. Only returned when the profile is listed publicly, so a private
// page never leaks the author's details even if editions exist.
export async function publicProfile(db: Database, handle: string) {
	const [row] = await db
		.select({
			displayName: users.displayName,
			penName: users.penName,
			bioMd: users.bioMd,
			links: users.links,
			commissionsOpen: users.commissionsOpen,
			commissionsMd: users.commissionsMd,
			avatarAssetId: users.avatarAssetId
		})
		.from(users)
		.where(and(eq(users.handle, handle), eq(users.profilePublic, true), isNull(users.suspendedAt)));
	return row ?? null;
}

// The owner's own view of their shelf header, listed or not, so they can
// preview the page before turning visibility on. Carries profilePublic so the
// caller can say when only the owner sees it.
export async function ownProfilePreview(db: Database, userId: string, handle: string) {
	const [row] = await db
		.select({
			displayName: users.displayName,
			penName: users.penName,
			bioMd: users.bioMd,
			links: users.links,
			commissionsOpen: users.commissionsOpen,
			commissionsMd: users.commissionsMd,
			avatarAssetId: users.avatarAssetId,
			profilePublic: users.profilePublic
		})
		.from(users)
		.where(and(eq(users.id, userId), eq(users.handle, handle)));
	return row ?? null;
}

// The author's name for the reader chrome. The crumb and the footer name the
// author on both reading pages whether or not they list their profile; the bio,
// links, avatar and commissions stay behind profilePublic in publicProfile.
export async function publicAuthorIdentity(db: Database, handle: string) {
	const [row] = await db
		.select({ penName: users.penName, displayName: users.displayName })
		.from(users)
		.where(and(eq(users.handle, handle), isNull(users.suspendedAt)));
	return row ?? null;
}

// True when an asset is the current avatar of a user whose profile is listed
// publicly, which makes it servable without a session. Turning the profile
// private or changing the avatar revokes public access immediately.
export async function isPublicAvatar(db: Database, assetId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(
			and(
				eq(users.avatarAssetId, assetId),
				eq(users.profilePublic, true),
				isNull(users.suspendedAt)
			)
		)
		.limit(1);
	return Boolean(row);
}

// The reader view: the current edition, provided the story is not
// private, no takedown applies, neither the story nor its universe is in
// the trash, and the author is not suspended. The ref is the story's id, or
// its slug when the story is listed publicly: a slug comes from the title and
// can be guessed, so an unlisted story answers only at its id. Slugs are unique among the owner's
// live stories, and the owner is the handle's.
export async function publicEdition(db: Database, handle: string, ref: string) {
	const [edition] = await db
		.select({
			id: publications.id,
			storyId: publications.storyId,
			slug: stories.slug,
			universeId: stories.universeId,
			title: publications.title,
			author: publications.author,
			descriptionMd: publications.descriptionMd,
			isAdult: publications.isAdult,
			content: publications.content,
			versionLabel: publications.versionLabel,
			downloadsPublic: publications.downloadsPublic,
			publishedAt: publications.publishedAt,
			visibility: stories.visibility,
			coverAssetId: stories.coverAssetId,
			// The reader chrome names the author by pen name, falling back to their
			// display name; the handle stays the address in the URL.
			penName: users.penName,
			displayName: users.displayName
		})
		.from(publications)
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.innerJoin(users, eq(publications.ownerId, users.id))
		.where(
			and(
				eq(publications.handle, handle),
				eq(stories.ownerId, publications.ownerId),
				isUuid(ref)
					? eq(publications.storyId, ref)
					: and(eq(stories.slug, ref), eq(stories.visibility, 'public')),
				eq(publications.isCurrent, true),
				isNull(publications.removedAt),
				storyIsLive(),
				isNull(users.suspendedAt)
			)
		);
	if (!edition || edition.visibility === 'private') return null;
	return {
		...edition,
		address: readingAddress({
			id: edition.storyId,
			slug: edition.slug,
			visibility: edition.visibility
		})
	};
}

// The public universe page: the universe's name and the author's listed
// stories in it, exactly as the shelf would show them. The ref is the
// universe's id or its slug. Null for the hidden home of one-off stories,
// a universe in the trash, and one with nothing listed, so a page never
// names a universe the author has not shown to readers. The name is the only
// live field shown; universes have no frozen published copy.
export async function publicUniverse(db: Database, handle: string, ref: string) {
	const [universe] = await db
		.select({ id: universes.id, name: universes.name, slug: universes.slug })
		.from(universes)
		.innerJoin(users, eq(universes.ownerId, users.id))
		.where(
			and(
				eq(users.handle, handle),
				isUuid(ref) ? eq(universes.id, ref) : eq(universes.slug, ref),
				eq(universes.standalone, false),
				isNull(universes.deletedAt),
				isNull(users.suspendedAt)
			)
		);
	if (!universe) return null;
	const shelf = await publicShelf(db, handle, universe.id);
	if (shelf.length === 0) return null;
	return { ...universe, shelf };
}

// The link from a story's reading page to its universe's page: the name and
// slug when publicUniverse would show that universe, else null. The same
// rules as publicUniverse and publicShelf, checked with one exists query.
export async function publicUniverseLink(db: Database, handle: string, universeId: string) {
	const listed = db
		.select({ id: publications.id })
		.from(publications)
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.where(
			and(
				eq(publications.handle, handle),
				eq(stories.ownerId, publications.ownerId),
				eq(stories.universeId, universes.id),
				eq(publications.isCurrent, true),
				isNull(publications.removedAt),
				isNull(stories.deletedAt),
				eq(stories.visibility, 'public')
			)
		);
	const [row] = await db
		.select({ name: universes.name, slug: universes.slug })
		.from(universes)
		.innerJoin(users, eq(universes.ownerId, users.id))
		.where(
			and(
				eq(users.handle, handle),
				eq(universes.id, universeId),
				eq(universes.standalone, false),
				isNull(universes.deletedAt),
				isNull(users.suspendedAt),
				exists(listed)
			)
		);
	return row ?? null;
}

// Where an old slug now leads, for the permanent redirect from a public
// address made before a rename: the story's current slug, but only while the
// story is readable at that slug (public, live, current edition, no
// takedown). An unlisted story is never a target, since the redirect would
// hand out its id. Null otherwise, and the old address 404s as before.
export async function publicStoryRedirect(
	db: Database,
	handle: string,
	oldSlug: string
): Promise<string | null> {
	const [row] = await db
		.select({ storyId: slugHistory.storyId })
		.from(slugHistory)
		.innerJoin(users, eq(slugHistory.ownerId, users.id))
		.where(
			and(eq(users.handle, handle), eq(slugHistory.kind, 'story'), eq(slugHistory.slug, oldSlug))
		);
	if (!row?.storyId) return null;
	const edition = await publicEdition(db, handle, row.storyId);
	if (!edition || edition.visibility !== 'public') return null;
	return edition.slug;
}

// The same for a universe's public page: its current slug while that page
// shows (publicUniverse), else null.
export async function publicUniverseRedirect(
	db: Database,
	handle: string,
	oldSlug: string
): Promise<string | null> {
	const [row] = await db
		.select({ universeId: slugHistory.universeId })
		.from(slugHistory)
		.innerJoin(users, eq(slugHistory.ownerId, users.id))
		.where(
			and(eq(users.handle, handle), eq(slugHistory.kind, 'universe'), eq(slugHistory.slug, oldSlug))
		);
	if (!row?.universeId) return null;
	const universe = await publicUniverseLink(db, handle, row.universeId);
	return universe?.slug ?? null;
}

// True when an asset belongs to a publicly readable edition, which makes
// it servable without a session: either the story's live cover, or an
// inline image the frozen prose references. The visibility test follows
// publicEdition (private excluded, unlisted reachable by link, story and
// universe out of the trash, author not suspended), so an asset never
// outlives the page it belongs to.
export async function isPublicAsset(db: Database, assetId: string): Promise<boolean> {
	const [cover] = await db
		.select({ id: publications.id })
		.from(publications)
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.where(
			and(
				eq(stories.coverAssetId, assetId),
				eq(publications.isCurrent, true),
				isNull(publications.removedAt),
				storyIsLive(),
				ne(stories.visibility, 'private'),
				authorNotSuspended(publications.ownerId)
			)
		)
		.limit(1);
	if (cover) return true;

	const [inline] = await db
		.select({ id: publications.id })
		.from(publicationAssets)
		.innerJoin(publications, eq(publicationAssets.publicationId, publications.id))
		.innerJoin(stories, eq(publications.storyId, stories.id))
		// Editions published before links were owner-checked may list another
		// user's image; only the author's own images are public through them.
		.innerJoin(
			assets,
			and(eq(assets.id, publicationAssets.assetId), eq(assets.ownerId, publications.ownerId))
		)
		.where(
			and(
				eq(publicationAssets.assetId, assetId),
				eq(publications.isCurrent, true),
				isNull(publications.removedAt),
				storyIsLive(),
				ne(stories.visibility, 'private'),
				authorNotSuspended(publications.ownerId)
			)
		)
		.limit(1);
	return Boolean(inline);
}

// Admin takedown: hides the edition without touching the author's source.
export async function takedownPublication(db: Database, publicationId: string): Promise<boolean> {
	const updated = await db
		.update(publications)
		.set({ removedAt: sql`now()` })
		.where(and(eq(publications.id, publicationId), isNull(publications.removedAt)))
		.returning({ id: publications.id });
	return updated.length > 0;
}

// The admin's view of everything published on this instance.
export async function listPublications(db: Database, limit = 50) {
	return await db
		.select({
			id: publications.id,
			handle: publications.handle,
			title: publications.title,
			isAdult: publications.isAdult,
			isCurrent: publications.isCurrent,
			removedAt: publications.removedAt,
			publishedAt: publications.publishedAt
		})
		.from(publications)
		.orderBy(desc(publications.publishedAt))
		.limit(limit);
}
