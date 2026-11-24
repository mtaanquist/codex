<script lang="ts">
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
</script>

<dl class="story-labels">
	{#if genres.length > 0}
		<div>
			<dt>{genres.length === 1 ? 'Genre' : 'Genres'}</dt>
			<dd>{genres.map((genre) => genre.name).join(', ')}</dd>
		</div>
	{/if}
	{#if fandoms.length > 0}
		<div>
			<dt>{fandoms.length === 1 ? 'Fandom' : 'Fandoms'}</dt>
			<dd>{fandoms.map((fandom) => fandom.name).join(', ')}</dd>
		</div>
	{/if}
	{#if tags.length > 0}
		<div>
			<dt>Tags</dt>
			<dd>{tags.map((tag) => tag.name).join(', ')}</dd>
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
