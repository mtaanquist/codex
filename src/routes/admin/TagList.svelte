<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { actionKeepingQuery, withQuery } from '#lib/href';
	import { confirmSubmit } from '#lib/confirm.svelte';

	// The list on the tag and list moderation pages: search, each entry
	// with how many stories use it, and rename, merge and remove.
	type Row = {
		id: string;
		name: string;
		removedAt: Date | null;
		mergedIntoName: string | null;
		uses: number;
	};
	let {
		list,
		query,
		kind,
		message,
		notice = null
	}: {
		list: { rows: Row[]; page: number; more: boolean };
		query: string;
		kind: 'tag' | 'fandom' | 'genre' | 'warning';
		message: string | null;
		// What the last action did, when it worked.
		notice?: string | null;
	} = $props();

	const noun = $derived(kind === 'warning' ? 'content warning' : kind);
	const path = $derived(
		{
			tag: resolve('/admin/tags'),
			fandom: resolve('/admin/fandoms'),
			genre: resolve('/admin/genres'),
			warning: resolve('/admin/warnings')
		}[kind]
	);

	let editing = $state<string | null>(null);

	function pageHref(n: number) {
		return withQuery(path, {
			q: query,
			page: n > 0 ? n : null
		});
	}
</script>

{#if message}
	<div class="status-banner error" role="alert">
		<span class="x">{message}</span>
	</div>
{:else if notice}
	<div class="status-banner ok" role="status">
		<span class="dot"></span><span class="v">{notice}</span>
	</div>
{/if}

<form class="tag-search" method="GET">
	<label class="visually-hidden" for="tag-search">Search {noun}s</label>
	<input
		id="tag-search"
		class="input"
		type="search"
		name="q"
		value={query}
		placeholder="Search {noun}s"
	/>
	<button class="btn btn-secondary" type="submit">Search</button>
</form>

<div class="admin-card tight">
	{#if list.rows.length === 0}
		<p class="admin-block-sub" style="margin:0;padding:var(--space-4) 0;">
			{#if list.page > 0}
				No {noun}s on this page. <a href={pageHref(0)}>Go to the first page</a>.
			{:else}
				{query ? `No ${noun}s match.` : `No ${noun}s yet.`}
			{/if}
		</p>
	{:else}
		<div class="attn-list">
			{#each list.rows as row (row.id)}
				<div class="list-row tag-row">
					<div class="list-main">
						<div class="list-title">
							{row.name}
							{#if row.removedAt}<span class="pill">removed</span>{/if}
						</div>
						<div class="list-sub">
							{row.uses}
							{row.uses === 1 ? 'story' : 'stories'}{#if row.mergedIntoName}
								- merged into {row.mergedIntoName}{/if}
						</div>
						{#if editing === row.id}
							<div class="tag-edit">
								<form method="POST" action={actionKeepingQuery('rename', page.url.searchParams)}>
									<input type="hidden" name="id" value={row.id} />
									<label class="visually-hidden" for="rename-{row.id}">
										New name for {row.name}
									</label>
									<input id="rename-{row.id}" class="input" name="name" value={row.name} required />
									<button class="btn btn-secondary btn-sm" type="submit">Rename</button>
								</form>
								{#if !row.mergedIntoName}
									<form method="POST" action={actionKeepingQuery('merge', page.url.searchParams)}>
										<input type="hidden" name="id" value={row.id} />
										<label class="visually-hidden" for="merge-{row.id}">
											Merge {row.name} into
										</label>
										<input
											id="merge-{row.id}"
											class="input"
											name="target"
											placeholder="Merge into (name)"
											required
										/>
										<button class="btn btn-secondary btn-sm" type="submit">Merge</button>
									</form>
								{/if}
							</div>
						{/if}
					</div>
					<div class="list-actions">
						<button
							class="btn btn-ghost btn-sm"
							type="button"
							aria-expanded={editing === row.id}
							onclick={() => (editing = editing === row.id ? null : row.id)}
						>
							{editing === row.id ? 'Close' : 'Edit'}
						</button>
						{#if row.mergedIntoName}
							<form method="POST" action={actionKeepingQuery('unmerge', page.url.searchParams)}>
								<input type="hidden" name="id" value={row.id} />
								<button class="btn btn-ghost btn-sm" type="submit">Undo merge</button>
							</form>
						{/if}
						{#if row.removedAt}
							<form method="POST" action={actionKeepingQuery('restore', page.url.searchParams)}>
								<input type="hidden" name="id" value={row.id} />
								<button class="btn btn-ghost btn-sm" type="submit">Restore</button>
							</form>
						{:else}
							<form
								method="POST"
								action={actionKeepingQuery('remove', page.url.searchParams)}
								onsubmit={confirmSubmit({
									title: `Remove the ${noun} "${row.name}"?`,
									body: row.mergedIntoName
										? `Stories with it keep showing "${row.mergedIntoName}", and authors cannot add it again. If you undo the merge, it stays hidden until you restore it.`
										: `It disappears from every story that has it, and authors cannot add it again. You can restore it later.`,
									confirmLabel: 'Remove',
									danger: true
								})}
							>
								<input type="hidden" name="id" value={row.id} />
								<button class="btn btn-ghost btn-sm danger" type="submit"> Remove </button>
							</form>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

{#if list.page > 0 || list.more}
	<div class="settings-actions">
		{#if list.page > 0}<a class="btn btn-ghost btn-sm" href={pageHref(list.page - 1)}>
				Previous
			</a>{/if}
		{#if list.more}<a class="btn btn-ghost btn-sm" href={pageHref(list.page + 1)}>Next</a>{/if}
	</div>
{/if}

<style>
	.tag-search {
		display: flex;
		gap: var(--space-2);
		margin-bottom: var(--space-4);
	}
	.tag-edit {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}
	.tag-edit form {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}
	.tag-edit .input {
		max-width: 18rem;
	}
	.tag-row {
		align-items: flex-start;
	}
</style>
