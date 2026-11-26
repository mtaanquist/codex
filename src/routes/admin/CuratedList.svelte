<script lang="ts">
	import { page } from '$app/state';
	import { actionKeepingQuery } from '#lib/href';
	import TagList from './TagList.svelte';

	// A moderation page for one curated list (fandoms, genres, content
	// warnings): a box to add entries, then the shared list.
	type Row = {
		id: string;
		name: string;
		removedAt: Date | null;
		mergedIntoName: string | null;
		uses: number;
	};
	let {
		data,
		form,
		kind,
		title,
		lede,
		placeholder
	}: {
		data: { list: { rows: Row[]; page: number; more: boolean }; query: string };
		form:
			| {
					scope: string;
					message?: string;
					notice?: string;
					added?: string[];
					skipped?: string[];
					removed?: string[];
			  }
			| null
			| undefined;
		kind: 'fandom' | 'genre' | 'warning';
		title: string;
		lede: string;
		placeholder: string;
	} = $props();
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Moderation</p>
	<h1 class="admin-title">{title}</h1>
	<p class="admin-lede">{lede}</p>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<div>
			<h2 class="admin-block-title">Add to the list</h2>
			<p class="admin-block-sub">One name per line. Names already on the list are skipped.</p>
		</div>
	</div>
	<div class="admin-card">
		<form method="POST" action={actionKeepingQuery('add', page.url.searchParams)}>
			{#if form?.scope === 'add' && form.message}
				<p class="form-error" role="alert">{form.message}</p>
			{:else if form?.scope === 'add' && form.added}
				<p class="field-hint" role="status" style="color:var(--status-final-ink);margin-top:0;">
					Added {form.added.length}.{#if form.skipped?.length}
						Already on the list: {form.skipped.join(', ')}.{/if}{#if form.removed?.length}
						Removed earlier, restore them below to use them again: {form.removed.join(', ')}.{/if}
				</p>
			{/if}
			<div class="field">
				<label for="list-names">Names</label>
				<textarea id="list-names" class="textarea" name="names" rows="5" {placeholder}></textarea>
			</div>
			<div class="settings-actions">
				<button class="btn btn-primary" type="submit">Add</button>
			</div>
		</form>
	</div>
</div>

<div class="admin-block">
	<TagList
		list={data.list}
		query={data.query}
		{kind}
		message={form?.scope === 'tags' ? (form.message ?? null) : null}
		notice={form?.scope === 'tags' ? (form.notice ?? null) : null}
	/>
</div>
