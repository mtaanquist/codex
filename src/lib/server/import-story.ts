import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from './auth';
import {
	assistantDrafts,
	chapters,
	characterStoryMemberships,
	characterStoryNotes,
	loreStoryNotes,
	notes,
	placeStoryMemberships,
	placeStoryNotes,
	scenes,
	stories,
	users
} from './db/schema';
import { entityNameColumn, entityTable, type EntityType } from './entity-lookups';
import { uniqueSlug } from './slugs';
import { isUniqueViolation } from './db-errors';
import { wordCount } from '../word-count';
import { clampDraftWords, MAX_DRAFT_BRIEF_CHARS } from '../scene-draft';
import { rewriteBundledAssetLinks, type ImportedNote, type ImportPlan } from '../import-markdown';
import { effectiveAssetConfig, createAsset, deleteAsset, s3AssetStore } from './assets';
import { createStoryEntity } from './create-entity';
import { queueUniverseMentions } from './jobs';
import { IMAGE_EXTENSIONS } from './media-types';
import { accountLimits, holdCountQuota, holdStoryQuota, quotaFailure } from './quotas';
import { imageLimit } from '../quota';
import { formatBytes } from '../format';
import { errorFields, logEvent } from './log';
import {
	checkTagNames,
	listedByName,
	setStoryList,
	setStoryTags,
	universeFandom,
	type ListKind
} from './tags';
import { cleanTagName, MAX_FANDOMS, MAX_GENRES, MAX_TAGS, tagSlug } from '../story-tags';

// Turns a parsed story zip into a new story in the chosen universe. The
// preview names every collision and how it will resolve; the commit follows
// exactly the rules the preview showed. Always a fresh story, never a merge.

type Universe = { id: string; ownerId: string };

export type NoteOutcome = 'match' | 'create' | 'ambiguous';
export type NoteResolution = ImportedNote & { outcome: NoteOutcome; entityId: string | null };

export type ImportPreview = {
	storyTitle: string;
	// A story with this exact title already exists in the universe; the
	// import still proceeds, as a second story.
	titleTaken: boolean;
	chapterCount: number;
	sceneCount: number;
	words: number;
	notes: { kind: ImportedNote['kind']; name: string; outcome: NoteOutcome }[];
	// Freeform notes from the story's notebook.
	freeformNoteCount: number;
	waitingDraftCount: number;
	assetCount: number;
	assetsConfigured: boolean;
	problems: string[];
};

// Each note finds its entity by trimmed, case-insensitive name within its
// kind. One candidate attaches, none creates, two or more skips: picking one
// silently would be the only wrong answer.
async function resolveNotes(
	db: Database,
	universeId: string,
	notes: ImportedNote[]
): Promise<NoteResolution[]> {
	if (notes.length === 0) return [];
	const namesIn = (type: EntityType) => {
		const table = entityTable(type);
		return db
			.select({ id: table.id, name: entityNameColumn(table) })
			.from(table)
			.where(eq(table.universeId, universeId));
	};
	const lists = {
		character: await namesIn('character'),
		place: await namesIn('place'),
		lore: await namesIn('lore_entry')
	};
	const byName = (rows: { id: string; name: string }[]) => {
		const map = new Map<string, string[]>();
		for (const row of rows) {
			const key = row.name.trim().toLowerCase();
			map.set(key, [...(map.get(key) ?? []), row.id]);
		}
		return map;
	};
	const maps = {
		character: byName(lists.character),
		place: byName(lists.place),
		lore: byName(lists.lore)
	};
	return notes.map((note) => {
		const candidates = maps[note.kind].get(note.name.trim().toLowerCase()) ?? [];
		if (candidates.length === 1) return { ...note, outcome: 'match', entityId: candidates[0] };
		if (candidates.length === 0) return { ...note, outcome: 'create', entityId: null };
		return { ...note, outcome: 'ambiguous', entityId: null };
	});
}

export async function previewImport(
	db: Database,
	universe: Universe,
	plan: ImportPlan
): Promise<ImportPreview> {
	const allScenes = [...plan.chapters.flatMap((chapter) => chapter.scenes), ...plan.unfiled];
	const titleRows = await db
		.select({ title: stories.title })
		.from(stories)
		.where(eq(stories.universeId, universe.id));
	const resolutions = await resolveNotes(db, universe.id, plan.notes);
	const problems = [...plan.problems];
	try {
		await holdCountQuota(db, universe.ownerId, { stories: 1 });
	} catch (err) {
		const reason = quotaFailure(err);
		if (reason === undefined) throw err;
		problems.unshift(reason);
	}
	const assetsConfigured = (await effectiveAssetConfig(db)) !== null;
	const limits = await accountLimits(db, universe.ownerId);
	const maxImage = imageLimit(limits);
	let imageBytes = 0;
	// Without image storage no image is imported, which the preview says once
	// (assetsConfigured), so the per-image and space warnings would only add noise.
	for (const asset of assetsConfigured ? plan.assets : []) {
		if (asset.bytes.length > maxImage) {
			problems.push(
				`The image ${asset.path} is larger than ${formatBytes(maxImage)} and will not be imported.`
			);
		} else {
			imageBytes += asset.bytes.length;
		}
	}
	if (limits.storage_bytes !== null && imageBytes > 0) {
		const [owner] = await db
			.select({ used: users.storageUsedBytes })
			.from(users)
			.where(eq(users.id, universe.ownerId));
		const left = Math.max(0, limits.storage_bytes - (owner?.used ?? 0));
		if (imageBytes > left) {
			problems.push(
				`The images in this file take ${formatBytes(imageBytes)}, but you have ${formatBytes(left)} of image storage left. Images that do not fit will not be imported.`
			);
		}
	}
	return {
		storyTitle: plan.story.title,
		titleTaken: titleRows.some((row) => row.title === plan.story.title),
		chapterCount: plan.chapters.length,
		sceneCount: allScenes.length,
		words: allScenes.reduce((sum, scene) => sum + wordCount(scene.bodyMd), 0),
		notes: resolutions.map(({ kind, name, outcome }) => ({ kind, name, outcome })),
		freeformNoteCount: plan.freeformNotes?.length ?? 0,
		waitingDraftCount: plan.waitingDrafts?.length ?? 0,
		assetCount: plan.assets.length,
		assetsConfigured,
		problems
	};
}

export type ImportResult = {
	storyId: string;
	slug: string;
	sceneCount: number;
	notesAttached: number;
	entitiesCreated: number;
	notesSkipped: number;
	freeformNotesCreated: number;
	waitingDraftsCreated: number;
	problems: string[];
};

export async function runImport(
	db: Database,
	universe: Universe,
	plan: ImportPlan
): Promise<ImportResult> {
	const problems = [...plan.problems];
	// Refuse before storing any image when the account has no room for the
	// story; the check inside the transaction below is the binding one.
	await holdCountQuota(db, universe.ownerId, { stories: 1 });

	// Assets first, outside the transaction: object storage is not
	// transactional anyway. Each bundled file becomes a new asset; links
	// rewrite to it.
	const assetLinks = new Map<string, string>();
	const storedAssets: string[] = [];
	let sceneCount = 0;
	let notesAttached = 0;
	let entitiesCreated = 0;
	let notesSkipped = 0;
	let freeformNotesCreated = 0;
	let waitingDraftsCreated = 0;

	let story: { id: string; slug: string };
	// Picked here so a failed write can tell whether its commit went through.
	const storyId = randomUUID();
	// From the first stored image on, a failure deletes the images stored so
	// far: nothing refers to them, and they would count against the storage
	// limit for good.
	try {
		const config = await effectiveAssetConfig(db);
		if (config && plan.assets.length > 0) {
			const store = s3AssetStore(config);
			const typeOf = new Map(Object.entries(IMAGE_EXTENSIONS).map(([type, ext]) => [ext, type]));
			for (const asset of plan.assets) {
				const extension = asset.path.slice(asset.path.lastIndexOf('.') + 1).toLowerCase();
				const created = await createAsset(db, store, config, universe.ownerId, {
					universeId: universe.id,
					kind: 'inline',
					filename: asset.path,
					contentType: typeOf.get(extension) ?? 'application/octet-stream',
					bytes: Buffer.from(asset.bytes)
				});
				if (created.ok) {
					assetLinks.set(asset.id, `/assets/${created.id}`);
					storedAssets.push(created.id);
				} else {
					problems.push(`The image ${asset.path} could not be stored: ${created.reason}`);
				}
			}
		} else if (plan.assets.length > 0) {
			problems.push('Image storage is not configured; bundled images were not imported.');
		}
		const rewrite = (body: string) =>
			rewriteBundledAssetLinks(body, (id) => assetLinks.get(id) ?? null);

		const resolutions = await resolveNotes(db, universe.id, plan.notes);

		// The slug is picked up front; the story row itself is inserted inside the
		// transaction below, so a failure partway through the import rolls the empty
		// story away rather than leaving a visible shell. A concurrent create can
		// take the picked slug before the import sets it; the import then tries
		// once more with a fresh pick, starting its counts and problems over.
		//
		// The account's quota lock is taken only at the end, once everything else
		// is written, so creates, restores and imports in other tabs wait for the
		// commit rather than for the whole import. The row goes in first under a
		// placeholder slug (the column default) and takes the picked one after the
		// quota lock, the order a create takes them in, since a create holding the
		// quota lock may be waiting on the same slug.
		// Labels from a Codex export: genres, warnings and fandoms this site's
		// lists do not have are left off and reported.
		const listed = async (kind: ListKind, names: string[], noun: string) => {
			const found = await listedByName(db, kind, names);
			for (const name of found.missing) {
				problems.push(`The ${noun} "${name}" is not on this site's list, so it was left off.`);
			}
			return found.ids;
		};
		const genres = await listed('genre', plan.story.genres ?? [], 'genre');
		const genreIds = genres.slice(0, MAX_GENRES);
		if (genres.length > MAX_GENRES) {
			problems.push(`Only the first ${MAX_GENRES} genres were kept.`);
		}
		const warningIds = await listed('warning', plan.story.contentWarnings ?? [], 'content warning');
		const tagNames = (plan.story.tags ?? []).filter((name) => {
			const cleaned = cleanTagName(name);
			if (!cleaned.ok && !cleaned.empty) problems.push(`The tag was left off: ${cleaned.reason}`);
			return cleaned.ok;
		});
		const tagSlugs = [...new Set(tagNames.map(tagSlug))];
		const keptSlugs = new Set(tagSlugs.slice(0, MAX_TAGS));
		const checkedTags = checkTagNames(tagNames.filter((name) => keptSlugs.has(tagSlug(name))));
		if (tagSlugs.length > MAX_TAGS) {
			problems.push(`Only the first ${MAX_TAGS} tags were kept.`);
		}
		// The universe's own fandom counts toward the limit and is not stored on
		// the story again.
		const fromUniverse = await universeFandom(db, universe.id);
		const ownFandoms = (await listed('fandom', plan.story.fandoms ?? [], 'fandom')).filter(
			(id) => id !== fromUniverse?.id
		);
		const fandomRoom = MAX_FANDOMS - (fromUniverse ? 1 : 0);
		const fandomIds = ownFandoms.slice(0, fandomRoom);
		if (ownFandoms.length > fandomRoom) {
			problems.push(`A story can have up to ${MAX_FANDOMS} fandoms, so some were left off.`);
		}

		const problemsBefore = problems.length;
		const write = (slug: string) =>
			db.transaction(async (tx) => {
				problems.length = problemsBefore;
				sceneCount = 0;
				notesAttached = 0;
				entitiesCreated = 0;
				notesSkipped = 0;
				freeformNotesCreated = 0;
				waitingDraftsCreated = 0;
				const [story] = await tx
					.insert(stories)
					.values({
						id: storyId,
						universeId: universe.id,
						ownerId: universe.ownerId,
						title: plan.story.title,
						author: plan.story.author,
						brief: plan.story.brief,
						descriptionMd: rewrite(plan.story.descriptionMd) || null,
						isAdult: plan.story.isAdult ?? false,
						styleNotes: plan.story.styleNotes ?? null,
						language: plan.story.language ?? null,
						assistantPreferences: plan.story.assistantPreferences ?? {},
						assistantNotes: plan.story.assistantNotes ?? null
					})
					.returning({ id: stories.id });
				if (checkedTags.ok) {
					const { skipped } = await setStoryTags(tx, story.id, checkedTags.tags);
					for (const name of skipped) {
						problems.push(
							`The tag "${name}" was removed by this site's moderators, so it was left off.`
						);
					}
				}
				await setStoryList(tx, story.id, 'fandom', fandomIds);
				await setStoryList(tx, story.id, 'genre', genreIds);
				await setStoryList(tx, story.id, 'warning', warningIds);
				let globalPosition = 0;
				const insertScene = async (
					scene: ImportPlan['unfiled'][number],
					chapterId: string | null,
					positionInChapter: number | null
				) => {
					const bodyMd = rewrite(scene.bodyMd);
					globalPosition += 1;
					sceneCount += 1;
					const [row] = await tx
						.insert(scenes)
						.values({
							storyId: story.id,
							chapterId,
							positionInChapter,
							globalPosition,
							title: scene.title,
							bodyMd,
							status: scene.status ?? 'draft',
							wordCount: wordCount(bodyMd)
						})
						.returning({ id: scenes.id });
					return row.id;
				};
				// New scene ids by plan position, for notebook notes attached to a scene.
				const chapterSceneIds: string[][] = [];
				const unfiledSceneIds: string[] = [];

				for (const [chapterIndex, chapter] of plan.chapters.entries()) {
					const [row] = await tx
						.insert(chapters)
						.values({
							storyId: story.id,
							title: chapter.title,
							summaryMd: chapter.summaryMd ? rewrite(chapter.summaryMd) : null,
							position: chapterIndex + 1
						})
						.returning({ id: chapters.id });
					const ids: string[] = [];
					for (const [sceneIndex, scene] of chapter.scenes.entries()) {
						ids.push(await insertScene(scene, row.id, sceneIndex + 1));
					}
					chapterSceneIds.push(ids);
				}
				for (const scene of plan.unfiled) {
					unfiledSceneIds.push(await insertScene(scene, null, null));
				}

				for (const note of resolutions) {
					let entityId = note.entityId;
					if (note.outcome === 'ambiguous') {
						notesSkipped += 1;
						problems.push(
							`${note.name}: more than one ${note.kind === 'lore' ? 'lore entry' : note.kind} shares this name; the note was skipped.`
						);
						continue;
					}
					if (note.outcome === 'create') {
						const created = await createStoryEntity(
							tx,
							{ universeId: universe.id, ownerId: universe.ownerId, storyId: story.id },
							note.kind === 'lore' ? 'lore_entry' : note.kind,
							note.name
						);
						if (!created.ok) {
							notesSkipped += 1;
							problems.push(
								`${note.name}: could not be created (${created.reason}); note skipped.`
							);
							continue;
						}
						entityId = created.id;
						entitiesCreated += 1;
					} else if (note.kind === 'character') {
						await tx
							.insert(characterStoryMemberships)
							.values({ characterId: entityId!, storyId: story.id })
							.onConflictDoNothing();
					} else if (note.kind === 'place') {
						await tx
							.insert(placeStoryMemberships)
							.values({ placeId: entityId!, storyId: story.id })
							.onConflictDoNothing();
					}
					const notesMd = rewrite(note.notesMd);
					if (note.kind === 'character') {
						await tx
							.insert(characterStoryNotes)
							.values({ characterId: entityId!, storyId: story.id, notesMd });
					} else if (note.kind === 'place') {
						await tx
							.insert(placeStoryNotes)
							.values({ placeId: entityId!, storyId: story.id, notesMd });
					} else {
						await tx
							.insert(loreStoryNotes)
							.values({ loreEntryId: entityId!, storyId: story.id, notesMd });
					}
					notesAttached += 1;
				}

				const sceneIdAt = (at: { chapter: number | null; index: number }) =>
					at.chapter === null ? unfiledSceneIds[at.index] : chapterSceneIds[at.chapter][at.index];

				for (const note of plan.freeformNotes ?? []) {
					await tx.insert(notes).values({
						ownerId: universe.ownerId,
						universeId: universe.id,
						storyId: story.id,
						sceneId: note.scene ? sceneIdAt(note.scene) : null,
						title: note.title,
						bodyMd: rewrite(note.bodyMd),
						pinned: note.pinned,
						// Undefined falls back to the column default for older zips.
						createdAt: note.createdAt ?? undefined
					});
					freeformNotesCreated += 1;
				}

				// Back as drafts waiting on their scenes, each asked for its scene alone.
				for (const draft of plan.waitingDrafts ?? []) {
					const textMd = rewrite(draft.textMd);
					await tx.insert(assistantDrafts).values({
						userId: universe.ownerId,
						storyId: story.id,
						sceneId: sceneIdAt(draft.scene),
						brief: draft.brief.slice(0, MAX_DRAFT_BRIEF_CHARS),
						targetWords: clampDraftWords(draft.targetWords ?? wordCount(textMd)),
						pov: draft.pov,
						textMd,
						status: 'ready',
						note: draft.note,
						chapterBrief: draft.chapterBrief,
						source: draft.source
					});
					waitingDraftsCreated += 1;
				}
				await holdStoryQuota(tx, universe.ownerId, universe.id, { inserted: true });
				await tx.update(stories).set({ slug }).where(eq(stories.id, story.id));
				return { id: story.id, slug };
			});
		const pick = () => uniqueSlug(db, 'stories', universe.ownerId, plan.story.title, 'story');
		try {
			story = await write(await pick());
		} catch (err) {
			// Only the slug is worth a second try; any other clash would recur.
			if (!isUniqueViolation(err, 'stories_owner_slug_idx')) throw err;
			story = await write(await pick());
		}
	} catch (err) {
		// A commit can land with its reply lost (the connection dropped), so the
		// story may be there after all, linking these images. Only delete them
		// once its row is known to be absent; if even that cannot be read, they
		// are left for the unused-image sweep.
		const landed = await db
			.select({ id: stories.id, slug: stories.slug })
			.from(stories)
			.where(eq(stories.id, storyId))
			.then(
				(rows) => rows[0] ?? null,
				() => undefined
			);
		if (landed === undefined) throw err;
		if (landed === null) {
			for (const id of storedAssets) {
				await deleteAsset(db, universe.ownerId, id).catch(() => {});
			}
			throw err;
		}
		logEvent('warn', 'import.commit_unconfirmed', { storyId, ...errorFields(err) });
		story = landed;
	}

	// One universe-wide rebuild covers every imported scene.
	await queueUniverseMentions(universe.id);

	return {
		storyId: story.id,
		slug: story.slug,
		sceneCount,
		notesAttached,
		entitiesCreated,
		notesSkipped,
		freeformNotesCreated,
		waitingDraftsCreated,
		problems
	};
}
