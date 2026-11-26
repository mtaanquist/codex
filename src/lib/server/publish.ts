import {
	and,
	asc,
	count,
	desc,
	eq,
	exists,
	ilike,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	sql,
	type AnyColumn
} from 'drizzle-orm';
import type { Database } from './auth.ts';
import {
	assets,
	publicationAssets,
	publicationReports,
	publications,
	slugHistory,
	stories,
	universes,
	users
} from './db/schema.ts';
import type { ReportReason } from '#lib/report-reasons';
import { gatherStory, type ExportScene } from './export.ts';
import { getDraft } from './story-drafts.ts';
import { findAssetReferences } from '#lib/markdown';
import { storyCoverColor } from '#lib/entity-color';
import { isForeignKeyViolation, isUniqueViolation } from './db-errors.ts';
import { storyIsLive } from './universe-scope.ts';
import { currentNotTakenDown } from './publication-scope.ts';
import { likePattern } from './sql-like.ts';
import { pageIndex } from './paging.ts';
import { tagsForStories } from './tags.ts';
import { isUuid, readingAddress, slugAddress } from '#lib/slug';

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
	const shownLabels = (await tagsForStories(db, [story.id])).get(story.id) ?? [];
	const warnings = shownLabels.filter((tag) => tag.kind === 'warning');
	try {
		const publicationId = await db.transaction(async (tx) => {
			// scheduleAccountDeletion updates this row first, so a deletion
			// scheduled at the same moment either commits before this read (and
			// the publish is refused) or waits and then takes the new edition
			// down with the others. "No key update" still waits on that update but
			// not on rows elsewhere that only reference this user.
			const [owner] = await tx
				.select({ deletionScheduledAt: users.deletionScheduledAt })
				.from(users)
				.where(eq(users.id, userId))
				.for('no key update');
			if (!owner || owner.deletionScheduledAt) return 'deleting' as const;
			// Locked so a takedown running at the same moment waits for this
			// publish (see takedownPublication).
			await tx
				.select({ id: stories.id })
				.from(stories)
				.where(eq(stories.id, story.id))
				.for('update');
			// A moderator's takedown holds until they restore the edition, so a
			// new publish cannot bring the story back on its own. Editions the
			// author's own account deletion took down carry no reason and do not
			// hold: after cancelling the deletion they can publish again.
			const [current] = await tx
				.select({ removedReason: publications.removedReason })
				.from(publications)
				.where(
					and(
						eq(publications.storyId, story.id),
						eq(publications.isCurrent, true),
						isNotNull(publications.removedAt)
					)
				);
			if (current?.removedReason) return 'taken-down' as const;
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
					// Like the adult flag, the author's current choice.
					contentWarnings: warnings.map((tag) => tag.name),
					contentWarningIds: warnings.map((tag) => tag.id),
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
		if (publicationId === 'deleting') {
			return { ok: false, reason: 'Your account is waiting to be deleted, so it cannot publish.' };
		}
		if (publicationId === 'taken-down') {
			return {
				ok: false,
				reason:
					'This story was taken down, so it cannot be published again until the people who look after this site restore it.'
			};
		}
		return { ok: true, publicationId };
	} catch (error) {
		// The partial unique index caught a concurrent publish of the same
		// story; the loser rolls back rather than leaving two current rows.
		if (isUniqueViolation(error)) {
			return { ok: false, reason: 'Another publish just finished. Reload the page and try again.' };
		}
		// An image the prose names was deleted between the read and the link
		// (the lock above should prevent it; this keeps it from being a 500).
		if (isForeignKeyViolation(error)) {
			return {
				ok: false,
				reason:
					'One of the images in this story was just deleted. Check the story and publish again.'
			};
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
	const labels = await tagsForStories(
		db,
		rows.map((row) => row.storyId)
	);
	return rows.map((row) => ({
		...row,
		genres: (labels.get(row.storyId) ?? [])
			.filter((tag) => tag.kind === 'genre')
			.map((tag) => tag.name),
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
			contentWarnings: publications.contentWarnings,
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
				storyIsLive(),
				eq(stories.visibility, 'public'),
				authorNotSuspended(publications.ownerId)
			)
		);
	const [row] = await db
		.select({ id: universes.id, name: universes.name, slug: universes.slug })
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
	return row ? { name: row.name, slug: slugAddress(row) } : null;
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
	return edition.address;
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

// Takes an edition down (an admin or a moderator) and closes every open
// report about it. The reason, a REPORT_REASONS key, is shown to the author.
// Taking down a superseded edition also takes down the story's current one,
// since a report can be about an edition the author has since replaced.
export async function takedownPublication(
	db: Database,
	publicationId: string,
	removedBy: string | null,
	// A takedown always has a reason. Account deletion hides editions by
	// setting removed_at alone (see scheduleAccountDeletion).
	reason: ReportReason
): Promise<boolean> {
	return await db.transaction(async (tx) => {
		const [target] = await tx
			.select({ storyId: publications.storyId })
			.from(publications)
			.where(eq(publications.id, publicationId));
		if (!target) return false;
		// The same lock publishStory takes, so a publish running at the same
		// moment either finishes first (and its edition is taken down here)
		// or waits and then sees the takedown.
		await tx
			.select({ id: stories.id })
			.from(stories)
			.where(eq(stories.id, target.storyId))
			.for('update');
		const updated = await tx
			.update(publications)
			// An edition already down with its author's account deletion gets
			// the reason too, so the takedown holds if the deletion is cancelled.
			// Down without a reason (the where clause) means account deletion
			// hid it, so the flag is set here too: one hidden before migration
			// 0124 has it false.
			.set({
				removedAt: sql`coalesce(${publications.removedAt}, now())`,
				removedBy,
				removedReason: reason,
				hiddenByAccountDeletion: sql`${publications.hiddenByAccountDeletion} or ${publications.removedAt} is not null`
			})
			.where(
				and(
					eq(publications.storyId, target.storyId),
					isNull(publications.removedReason),
					or(eq(publications.id, publicationId), eq(publications.isCurrent, true))
				)
			)
			.returning({ id: publications.id });
		if (updated.length === 0) return false;
		await tx
			.update(publicationReports)
			.set({ resolvedAt: sql`now()`, resolvedBy: removedBy, resolution: 'taken_down' })
			.where(
				and(
					// Every edition of the story, so a report on an older one closes too.
					inArray(
						publicationReports.publicationId,
						tx
							.select({ id: publications.id })
							.from(publications)
							.where(eq(publications.storyId, target.storyId))
					),
					isNull(publicationReports.resolvedAt)
				)
			);
		return true;
	});
}

// Lifts a moderator's takedown, so the author can publish new editions and the
// edition is public again, unless the author's account deletion also hid it:
// then it stays down, as cancelling the deletion leaves the author's other
// editions. Never while the author's account is waiting to be deleted.
// restoredBy is the moderator, recorded with the time.
export async function restorePublication(
	db: Database,
	publicationId: string,
	restoredBy: string | null
): Promise<boolean> {
	return await db.transaction(async (tx) => {
		const [edition] = await tx
			.select({ ownerId: publications.ownerId })
			.from(publications)
			.where(eq(publications.id, publicationId));
		if (!edition) return false;
		// scheduleAccountDeletion updates this row first, so a deletion
		// scheduled at the same moment either commits before this read (and the
		// restore is refused) or waits until the restore has committed.
		const [owner] = await tx
			.select({ deletionScheduledAt: users.deletionScheduledAt })
			.from(users)
			.where(eq(users.id, edition.ownerId))
			.for('update');
		if (!owner || owner.deletionScheduledAt) return false;
		const restored = await tx
			.update(publications)
			.set({
				removedAt: sql`case when ${publications.hiddenByAccountDeletion} then ${publications.removedAt} end`,
				removedBy: null,
				removedReason: null,
				restoredAt: sql`now()`,
				restoredBy
			})
			.where(
				and(
					eq(publications.id, publicationId),
					isNotNull(publications.removedAt),
					isNotNull(publications.removedReason)
				)
			)
			.returning({ id: publications.id });
		return restored.length > 0;
	});
}

export const LIVE_EDITIONS_PAGE_SIZE = 50;

// The display name of the moderator a column points at, for the moderation
// pages' records. Null once that account is gone.
function moderatorName(column: AnyColumn) {
	return sql<
		string | null
	>`(select ${users.displayName} from ${users} where ${users.id} = ${column})`;
}

// The Published page: every story's current edition that is not taken down,
// newest first, one page at a time, optionally narrowed to a handle or title.
// That includes editions an account deletion hid (hiddenAt set), so a
// moderator can still take them down.
export async function listLiveEditions(
	db: Database,
	{ query = '', page = 0 }: { query?: string; page?: number } = {}
) {
	const safePage = pageIndex(page);
	const text = query.trim();
	// Handles are stored without the '@' the pages show before them.
	const handlePattern = likePattern(text.replace(/^@/, ''));
	const where = and(
		currentNotTakenDown(),
		text
			? or(ilike(publications.handle, handlePattern), ilike(publications.title, likePattern(text)))
			: undefined
	);
	const [{ total }] = await db.select({ total: count() }).from(publications).where(where);
	// One row past the page says whether a next page exists.
	const rows = await db
		.select({
			id: publications.id,
			handle: publications.handle,
			title: publications.title,
			isAdult: publications.isAdult,
			publishedAt: publications.publishedAt,
			storyId: publications.storyId,
			listedInBrowse: stories.listedInBrowse,
			browseBlockedAt: stories.browseBlockedAt,
			// Down with no takedown reason: the author's account deletion hid it.
			hiddenAt: publications.removedAt,
			ownerDeletionPending: sql<boolean>`${users.deletionScheduledAt} is not null`,
			restoredAt: publications.restoredAt,
			restoredByName: moderatorName(publications.restoredBy),
			browseAllowedAt: stories.browseAllowedAt,
			browseAllowedByName: moderatorName(stories.browseAllowedBy),
			// Whether the title links to the moderator's view of the text.
			viewable: moderatorMayRead()
		})
		.from(publications)
		.innerJoin(stories, eq(stories.id, publications.storyId))
		.innerJoin(users, eq(users.id, publications.ownerId))
		.where(where)
		.orderBy(desc(publications.publishedAt), asc(publications.id))
		.limit(LIVE_EDITIONS_PAGE_SIZE + 1)
		.offset(safePage * LIVE_EDITIONS_PAGE_SIZE);
	return {
		editions: rows.slice(0, LIVE_EDITIONS_PAGE_SIZE),
		total,
		page: safePage,
		hasMore: rows.length > LIVE_EDITIONS_PAGE_SIZE
	};
}

// Stories a moderator removed from Browse, oldest first, so "Allow in Browse
// again" stays reachable however many editions are published after them.
export async function listBrowseBlocked(db: Database) {
	return await db
		.select({
			storyId: stories.id,
			title: stories.title,
			handle: users.handle,
			browseBlockedAt: stories.browseBlockedAt,
			browseBlockedReason: stories.browseBlockedReason,
			browseBlockedByName: moderatorName(stories.browseBlockedBy)
		})
		.from(stories)
		.innerJoin(users, eq(users.id, stories.ownerId))
		.where(isNotNull(stories.browseBlockedAt))
		.orderBy(stories.browseBlockedAt);
}

// Current editions a moderator took down, oldest takedown first, for the
// Restore list. Separate from listLiveEditions so none drop out of view.
export async function listTakenDown(db: Database) {
	return await db
		.select({
			id: publications.id,
			handle: publications.handle,
			title: publications.title,
			removedAt: publications.removedAt,
			removedReason: publications.removedReason,
			removedByName: moderatorName(publications.removedBy),
			hiddenByAccountDeletion: publications.hiddenByAccountDeletion,
			ownerDeletionPending: sql<boolean>`${users.deletionScheduledAt} is not null`
		})
		.from(publications)
		.innerJoin(users, eq(users.id, publications.ownerId))
		.where(
			and(
				eq(publications.isCurrent, true),
				isNotNull(publications.removedAt),
				isNotNull(publications.removedReason)
			)
		)
		.orderBy(publications.removedAt);
}

// Whether a moderator may read an edition's text on its own page: it is the
// current edition of a story still shared (not private, not in the trash), or
// the edition was taken down, or has a report that is open or was resolved by
// a takedown. So work an author withdrew, or an edition they replaced, is not
// read without cause, and a dismissed report does not unlock it for good.
function moderatorMayRead() {
	return sql<boolean>`((${publications.isCurrent} and ${stories.visibility} <> 'private' and ${storyIsLive()}) or ${publications.removedReason} is not null or exists (select 1 from ${publicationReports} where ${publicationReports.publicationId} = ${publications.id} and (${publicationReports.resolvedAt} is null or ${publicationReports.resolution} = 'taken_down')))`;
}

// Whether a moderator may load an uploaded image: one shown inline in an
// edition whose text they may read on its own page, so the image of a
// taken-down or hidden edition can be checked too. Only the edition owner's
// own images, as for readers (isPublicAsset).
export async function moderatorMayReadAsset(db: Database, assetId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: publications.id })
		.from(publicationAssets)
		.innerJoin(publications, eq(publicationAssets.publicationId, publications.id))
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.innerJoin(
			assets,
			and(eq(assets.id, publicationAssets.assetId), eq(assets.ownerId, publications.ownerId))
		)
		.where(and(eq(publicationAssets.assetId, assetId), moderatorMayRead()))
		.limit(1);
	return Boolean(row);
}

// One edition as a moderator sees it: taken down, hidden by an account
// deletion, superseded or live. For checking the text of a report before
// acting on it, or again before a restore. An older edition, or one of a
// story the author has since made private or put in the trash, opens only
// when it was taken down or has an open or upheld report (moderatorMayRead).
export async function moderatorEdition(db: Database, publicationId: string) {
	const shared = sql`(${stories.visibility} <> 'private' and ${storyIsLive()})`;
	const [edition] = await db
		.select({
			id: publications.id,
			storyId: publications.storyId,
			handle: publications.handle,
			title: publications.title,
			descriptionMd: publications.descriptionMd,
			isAdult: publications.isAdult,
			contentWarnings: publications.contentWarnings,
			content: publications.content,
			versionLabel: publications.versionLabel,
			publishedAt: publications.publishedAt,
			isCurrent: publications.isCurrent,
			removedAt: publications.removedAt,
			removedReason: publications.removedReason,
			removedByName: moderatorName(publications.removedBy),
			restoredAt: publications.restoredAt,
			restoredByName: moderatorName(publications.restoredBy),
			ownerDeletionPending: sql<boolean>`${users.deletionScheduledAt} is not null`,
			// Whether readers can open it at its public address right now.
			// The same checks as publicEdition, so the link it gates never 404s.
			readable: sql<boolean>`(${shared} and ${stories.ownerId} = ${publications.ownerId} and ${publications.isCurrent} and ${publications.removedAt} is null and ${users.suspendedAt} is null)`
		})
		.from(publications)
		.innerJoin(stories, eq(stories.id, publications.storyId))
		.innerJoin(users, eq(users.id, publications.ownerId))
		.where(and(eq(publications.id, publicationId), moderatorMayRead()));
	return edition ? { ...edition, content: edition.content as EditionContent } : null;
}
