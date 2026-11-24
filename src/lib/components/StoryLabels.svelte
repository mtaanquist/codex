<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { withQuery } from '#lib/href';
	// A published story's genres, fandoms, tags and content warnings, under
	// the byline on its reading page and on the adult gate. Warnings always
	// show, and say so when the author added none.
	let {
		genres,
		fandoms,
		tags,
		contentWarnings
	}: {
		genres: { name: string; slug: string }[];
		fandoms: { name: string; slug: string }[];
		tags: { name: string; slug: string }[];
		contentWarnings: string[];
	} = $props();

	// With Browse on, a genre, fandom or tag links to the stories that share it.
	const browseHref = (key: 'genre' | 'fandom' | 'tag', slug: string) =>
		withQuery(resolve('/browse'), { [key]: slug });
</script>

{#snippet list(key: 'genre' | 'fandom' | 'tag', items: { name: string; slug: string }[])}
	{#each items as item, index (item.slug)}{#if index > 0},
		{/if}{#if page.data.browse}<a href={browseHref(key, item.slug)}>{item.name}</a
			>{:else}{item.name}{/if}{/each}
{/snippet}

<dl class="story-labels">
	{#if genres.length > 0}
		<div>
			<dt>{genres.length === 1 ? 'Genre' : 'Genres'}</dt>
			<dd>{@render list('genre', genres)}</dd>
		</div>
	{/if}
	{#if fandoms.length > 0}
		<div>
			<dt>{fandoms.length === 1 ? 'Fandom' : 'Fandoms'}</dt>
			<dd>{@render list('fandom', fandoms)}</dd>
		</div>
	{/if}
	{#if tags.length > 0}
		<div>
			<dt>Tags</dt>
			<dd>{@render list('tag', tags)}</dd>
		</div>
	{/if}
	<div>
		<dt>Content warnings</dt>
		<dd>
			{#if contentWarnings.length > 0}
				{contentWarnings.join(', ')}
			{:else}
				The author added no content warnings.
			{/if}
		</dd>
	</div>
</dl>

<style>
	.story-labels {
		margin: var(--space-4) 0 0;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	.story-labels div {
		display: flex;
		gap: var(--space-2);
		margin-top: 4px;
	}
	.story-labels dt {
		font-weight: 600;
		color: var(--text);
		flex: none;
	}
	.story-labels dt::after {
		content: ':';
	}
	.story-labels dd {
		margin: 0;
	}
</style>
