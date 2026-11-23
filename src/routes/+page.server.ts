import { fail, redirect } from '@sveltejs/kit';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { universes } from '#lib/server/db/schema';
import { isUuid } from '#lib/slug';
import {
	createStoryInUniverse,
	createUniverse,
	standaloneUniverse
} from '#lib/server/story-create';
import { holdCountQuota, quotaFailure } from '#lib/server/quotas';
import { storyStatus } from '#lib/dashboard';
import { storyCoverColor } from '#lib/entity-color';
import {
	destroyUniverse,
	listTrashedUniverses,
	restoreUniverse
} from '#lib/server/universe-lifecycle';
import { destroyStory, listTrashedStories, restoreStory } from '#lib/server/story-lifecycle';
import { queueUnusedAssetSweep } from '#lib/server/jobs';
import { signupMode } from '#lib/server/settings';
import { saveLibraryView, userPreferences } from '#lib/server/preferences';
import { formText } from '#lib/server/validation';
import { draftsByStory } from '#lib/server/story-drafts';
import { countProposals } from '#lib/server/proposals';

export const load: PageServerLoad = async ({ locals }) => {
	// Signed-out visitors get the landing page. The page checks the layout's
	// `user` for which face to show; returning a `user` key here would shadow
	// the layout's shape (and once dropped the admin link from the avatar menu
	// by losing its isAdmin flag).
	if (!locals.user) {
		return {
			universes: [],
			stories: [],
			trashedUniverses: [],
			trashedStories: [],
			// The mode, not a boolean: the landing page offers a sign-up only
			// where a visitor without an invite code can finish one.
			signupMode: await signupMode(db)
		};
	}
	const user = locals.user;
	const list = await db
		.select()
		.from(universes)
		.where(and(eq(universes.ownerId, user.id), isNull(universes.deletedAt)))
		.orderBy(desc(universes.updatedAt));
	const trashedUniverses = await listTrashedUniverses(db, user.id);
	const trashedStories = await listTrashedStories(db, user.id);
	// Saved drafts, for the menu on each story's cover.
	const drafts = await draftsByStory(db, user.id);

	// One row per story with everything its card shows: chapter and word
	// totals, scene status counts for the pill, and when anything in it
	// was last touched.
	const result = await db.execute(sql`
		select st.id, st.slug, st.title, st.brief, st.universe_id,
			st.cover_asset_id, st.cover_color, st.position_in_series, st.created_at,
			(select count(*)::int from chapters c where c.story_id = st.id) as chapters,
			count(s.id)::int as scene_count,
			coalesce(sum(s.word_count), 0)::int as words,
			count(s.id) filter (where s.status = 'outline')::int as outline,
			count(s.id) filter (where s.status = 'draft')::int as draft,
			count(s.id) filter (where s.status = 'revised')::int as revised,
			count(s.id) filter (where s.status = 'final')::int as final,
			-- Trashed scenes count too: trashing one is itself a change, and the
			-- time must not move backwards when the newest scene goes.
			greatest(st.updated_at, (
				select max(coalesce(t.touched_at, t.updated_at)) from scenes t where t.story_id = st.id
			)) as edited_at
		from stories st
		join universes u on u.id = st.universe_id and u.deleted_at is null
		left join scenes s on s.story_id = st.id and s.deleted_at is null
		where st.owner_id = ${user.id} and st.deleted_at is null
		group by st.id
		order by st.position_in_series asc nulls last, st.created_at asc
	`);
	const storyList = result.rows.map((row) => {
		const r = row as {
			id: string;
			slug: string;
			title: string;
			brief: string | null;
			universe_id: string;
			cover_asset_id: string | null;
			cover_color: string | null;
			chapters: number;
			scene_count: number;
			words: number;
			outline: number;
			draft: number;
			revised: number;
			final: number;
			edited_at: string | Date;
		};
		const editedAt = new Date(r.edited_at);
		return {
			id: r.id,
			slug: r.slug,
			title: r.title,
			brief: r.brief,
			universeId: r.universe_id,
			coverAssetId: r.cover_asset_id,
			coverColor: storyCoverColor({ id: r.id, coverColor: r.cover_color }),
			chapters: r.chapters,
			words: r.words,
			editedAt: editedAt.toISOString(),
			drafts: drafts.get(r.id) ?? [],
			status: storyStatus({
				sceneCount: r.scene_count,
				words: r.words,
				outline: r.outline,
				draft: r.draft,
				revised: r.revised,
				final: r.final
			})
		};
	});

	// What the Assistant or an app left for the writer to decide, per universe.
	const waiting = await countProposals(db, user.id);

	return {
		libraryView: (await userPreferences(db, user.id)).libraryView,
		universes: list.map((universe) => ({ ...universe, waiting: waiting.get(universe.id) ?? 0 })),
		stories: storyList,
		trashedUniverses,
		trashedStories
	};
};

export const actions: Actions = {
	// The view switch above the stories; the same setting as on the account page.
	setLibraryView: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		const view = (await request.formData()).get('libraryView');
		if (!(await saveLibraryView(db, locals.user.id, view))) {
			return fail(400, { scope: 'view', message: 'Pick a library view.' });
		}
		return { scope: 'view', saved: true };
	},
	createUniverse: async ({ request, locals }) => {
		// The route is public for the landing page; the action is not.
		if (!locals.user) redirect(303, '/login');
		const data = await request.formData();
		const name = formText(data, 'name').trim();
		if (!name) {
			return fail(400, { scope: 'universe', message: 'Give the universe a name.' });
		}
		let universe;
		try {
			universe = await createUniverse(db, locals.user.id, name);
		} catch (err) {
			const message = quotaFailure(err);
			if (message === undefined) throw err;
			return fail(403, { scope: 'universe', message });
		}
		redirect(303, `/universes/${universe.slug}`);
	},
	// The dashboard's per-universe new-story card.
	createStory: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		const data = await request.formData();
		const universeId = formText(data, 'universeId');
		const title = formText(data, 'title').trim();
		if (!title) {
			return fail(400, { scope: 'story', universeId, message: 'Give the story a title.' });
		}
		// Guard the uuid cast: a tampered id would throw in Postgres and 500.
		if (!isUuid(universeId)) {
			return fail(404, { scope: 'story', universeId, message: 'That universe does not exist.' });
		}
		const [universe] = await db
			.select({ id: universes.id })
			.from(universes)
			.where(and(eq(universes.id, universeId), eq(universes.ownerId, locals.user.id)));
		if (!universe) {
			return fail(404, { scope: 'story', universeId, message: 'That universe does not exist.' });
		}
		let story;
		try {
			story = await createStoryInUniverse(db, locals.user.id, universe.id, title);
		} catch (err) {
			const message = quotaFailure(err);
			if (message === undefined) throw err;
			return fail(403, { scope: 'story', universeId, message });
		}
		redirect(303, `/stories/${story.slug}`);
	},
	// The header's "New story": a story on its own, filed under the owner's
	// lazily created "Standalone stories" universe.
	createStandaloneStory: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		const title = formText(await request.formData(), 'title').trim();
		if (!title) {
			return fail(400, { scope: 'standalone', message: 'Give the story a title.' });
		}
		let story;
		try {
			// Checked first too, so a refused story does not leave the
			// standalone universe made for it.
			await holdCountQuota(db, locals.user.id, { stories: 1 });
			const universe = await standaloneUniverse(db, locals.user.id);
			story = await createStoryInUniverse(db, locals.user.id, universe.id, title);
		} catch (err) {
			const message = quotaFailure(err);
			if (message === undefined) throw err;
			return fail(403, { scope: 'standalone', message });
		}
		redirect(303, `/stories/${story.slug}`);
	},
	restoreUniverse: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		const data = await request.formData();
		const universeId = formText(data, 'universeId');
		if (!isUuid(universeId)) {
			return fail(404, { scope: 'trash', message: 'That universe is not in the trash.' });
		}
		let ok;
		try {
			ok = await restoreUniverse(db, locals.user.id, universeId);
		} catch (err) {
			const message = quotaFailure(err);
			if (message === undefined) throw err;
			return fail(403, { scope: 'trash', message });
		}
		if (!ok) return fail(404, { scope: 'trash', message: 'That universe is not in the trash.' });
		return { scope: 'trash', restored: true };
	},
	destroyUniverse: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		const data = await request.formData();
		const universeId = formText(data, 'universeId');
		if (!isUuid(universeId)) {
			return fail(404, { scope: 'trash', message: 'That universe is not in the trash.' });
		}
		const result = await destroyUniverse(db, locals.user.id, universeId);
		if (!result.ok) {
			return fail(404, { scope: 'trash', message: 'That universe is not in the trash.' });
		}
		return { scope: 'trash', destroyed: true };
	},
	restoreStory: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		const data = await request.formData();
		const storyId = formText(data, 'storyId');
		let ok;
		try {
			ok = isUuid(storyId) && (await restoreStory(db, locals.user.id, storyId));
		} catch (err) {
			const message = quotaFailure(err);
			if (message === undefined) throw err;
			return fail(403, { scope: 'story-trash', message });
		}
		if (!ok) {
			return fail(404, { scope: 'story-trash', message: 'That story is not in the trash.' });
		}
		return { scope: 'story-trash', restored: true };
	},
	destroyStory: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		const data = await request.formData();
		const storyId = formText(data, 'storyId');
		if (!isUuid(storyId) || !(await destroyStory(db, locals.user.id, storyId))) {
			return fail(404, { scope: 'story-trash', message: 'That story is not in the trash.' });
		}
		// Frees the images only that story used, in the background.
		await queueUnusedAssetSweep();
		return { scope: 'story-trash', destroyed: true };
	}
};
