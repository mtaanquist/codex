import { fail, type RequestEvent } from '@sveltejs/kit';
import { db } from './db';
import { requireModerator } from './roles';
import { isUuid } from '#lib/slug';
import { formText } from './validation';
import {
	addListEntries,
	listTagsForModeration,
	mergeTag,
	renameTag,
	setTagRemoved,
	unmergeTag,
	type ListKind,
	type TagKind
} from './tags';

// The shared load and actions of the tag and list moderation pages (Tags,
// Fandoms, Genres, Content warnings). They differ only in the kind of entry,
// and in that the curated lists can be added to.

export async function loadTagPage(locals: App.Locals, url: URL, kind: TagKind) {
	requireModerator(locals);
	const query = url.searchParams.get('q') ?? '';
	return {
		query,
		list: await listTagsForModeration(db, kind, {
			query,
			page: Number(url.searchParams.get('page')) || 0
		})
	};
}

async function withId(
	event: RequestEvent,
	run: (id: string, data: FormData) => Promise<string | null>
) {
	requireModerator(event.locals);
	const data = await event.request.formData();
	const id = formText(data, 'id');
	if (!isUuid(id)) return fail(400, { scope: 'tags', message: 'That entry does not exist.' });
	const message = await run(id, data);
	if (message) return fail(400, { scope: 'tags', message });
	return { scope: 'tags', done: true };
}

export const tagActions = {
	rename: (event: RequestEvent) =>
		withId(event, async (id, data) => {
			const result = await renameTag(db, id, formText(data, 'name'));
			return result.ok ? null : result.message;
		}),
	merge: (event: RequestEvent) =>
		withId(event, async (id, data) => {
			const result = await mergeTag(db, id, formText(data, 'target'));
			return result.ok ? null : result.message;
		}),
	unmerge: (event: RequestEvent) =>
		withId(event, async (id) => ((await unmergeTag(db, id)) ? null : 'That entry is not merged.')),
	remove: (event: RequestEvent) =>
		withId(event, async (id) =>
			(await setTagRemoved(db, id, true, event.locals.user!.id))
				? null
				: 'That entry does not exist.'
		),
	restore: (event: RequestEvent) =>
		withId(event, async (id) =>
			(await setTagRemoved(db, id, false, event.locals.user!.id))
				? null
				: 'That entry does not exist.'
		)
};

// The actions of a curated list page: the shared ones plus adding entries.
export function listActions(kind: ListKind) {
	return {
		...tagActions,
		add: async ({ request, locals }: RequestEvent) => {
			requireModerator(locals);
			const result = await addListEntries(db, kind, formText(await request.formData(), 'names'));
			if (!result.ok) return fail(400, { scope: 'add', message: result.message });
			return { scope: 'add', added: result.added, skipped: result.skipped };
		}
	};
}
