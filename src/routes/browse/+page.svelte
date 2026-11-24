<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { withQuery } from '#lib/href';
	import AppBar from '#lib/components/AppBar.svelte';
	import ReaderFooter from '#lib/components/ReaderFooter.svelte';
	import ShelfGrid from '#lib/components/ShelfGrid.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const ADULT_KEY = 'codex:browse-adult';
	const browse = resolve('/browse');

	// The reader's choice to include adult work is remembered on this device
	// only, and only ticks the box: it never changes results by itself.
	let adult = $derived(data.query.adult);
	onMount(() => {
		try {
			if (!data.query.adult && localStorage.getItem(ADULT_KEY) === 'show') adult = true;
		} catch {
			// Storage can be blocked; the box just starts unticked.
		}
	});
	function rememberAdult() {
		try {
			if (adult) localStorage.setItem(ADULT_KEY, 'show');
			else localStorage.removeItem(ADULT_KEY);
		} catch {
			// Nothing to remember it in.
		}
	}

	// The same search with one more page.
	const nextHref = $derived(
		data.next
			? withQuery(browse, {
					q: data.query.q,
					genre: data.query.genre,
					fandom: data.query.fandom,
					tag: data.query.tag,
					adult: data.query.adult ? 'show' : null,
					hide: data.query.hide,
					after: data.next
				})
			: null
	);

	const heading = $derived(
		data.filters.tag
			? `Stories tagged ${data.filters.tag.name}`
			: data.filters.fandom && !data.filters.genre
				? data.filters.fandom
				: data.filters.genre && !data.filters.fandom
					? data.filters.genre
					: 'Browse'
	);
</script>

<svelte:head>
	<title>{heading === 'Browse' ? 'Browse stories' : `${heading} - Browse`}</title>
	{#if !data.indexable}
		<meta name="robots" content="noindex" />
	{/if}
</svelte:head>

<div class="public-surface">
	<AppBar shell="public" />

	<main id="main" class="public-main">
		<div class="public-in">
			<div class="browse-head">
				<h1 class="browse-title">{heading}</h1>
				<p class="browse-lede">Stories the writers on this site have chosen to share.</p>
			</div>

			<form class="browse-form" method="GET" action={browse} onsubmit={rememberAdult}>
				<div class="browse-search">
					<label class="visually-hidden" for="browse-q">Search stories</label>
					<input
						id="browse-q"
						class="input"
						type="search"
						name="q"
						value={data.query.q}
						placeholder="Title, author, description or world"
					/>
					<button class="btn btn-primary" type="submit">Search</button>
				</div>
				<div class="browse-filters">
					<div class="field">
						<label for="browse-genre">Genre</label>
						<select id="browse-genre" class="select" name="genre" value={data.query.genre ?? ''}>
							<option value="">Any genre</option>
							{#each data.lists.genres as genre (genre.slug)}
								<option value={genre.slug}>{genre.name}</option>
							{/each}
						</select>
					</div>
					{#if data.lists.fandoms.length > 0}
						<div class="field">
							<label for="browse-fandom">Fandom</label>
							<select
								id="browse-fandom"
								class="select"
								name="fandom"
								value={data.query.fandom ?? ''}
							>
								<option value="">Any fandom</option>
								{#each data.lists.fandoms as fandom (fandom.slug)}
									<option value={fandom.slug}>{fandom.name}</option>
								{/each}
							</select>
						</div>
					{/if}
					{#if data.filters.tag}
						<div class="field">
							<span class="field-label">Tag</span>
							<label class="check-row">
								<input type="checkbox" name="tag" value={data.filters.tag.slug} checked />
								{data.filters.tag.name}
							</label>
						</div>
					{/if}
				</div>
				{#if data.lists.warnings.length > 0}
					<fieldset class="browse-hide">
						<legend>Hide stories with</legend>
						{#each data.lists.warnings as warning (warning.slug)}
							<label class="check-row">
								<input
									type="checkbox"
									name="hide"
									value={warning.slug}
									checked={data.query.hide.includes(warning.slug)}
								/>
								{warning.name}
							</label>
						{/each}
					</fieldset>
				{/if}
				<label class="check-row browse-adult">
					<input type="checkbox" name="adult" value="show" bind:checked={adult} />
					Include adult content. I am of legal age to view this content where I live.
				</label>
			</form>

			{#if data.authors.length > 0}
				<section class="browse-authors" aria-labelledby="browse-authors-title">
					<h2 id="browse-authors-title" class="browse-section-title">Writers</h2>
					<ul>
						{#each data.authors as author (author.handle)}
							<li>
								<a href={resolve('/@[handle]', { handle: author.handle })}>{author.name}</a>
								<span class="browse-count">
									{author.stories}
									{author.stories === 1 ? 'story' : 'stories'}
								</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<section aria-labelledby="browse-results-title">
				<h2 id="browse-results-title" class="visually-hidden">Stories</h2>
				{#if data.books.length === 0}
					<p class="browse-empty">
						{data.query.after
							? 'There are no more stories.'
							: 'No stories match. Try fewer filters or another search.'}
					</p>
				{:else}
					<ShelfGrid books={data.books} />
				{/if}
			</section>

			{#if nextHref || data.query.after}
				<nav class="browse-pages" aria-label="More stories">
					{#if data.query.after}
						<a href={browse}>Back to the newest</a>
					{/if}
					{#if nextHref}
						<a href={nextHref}>Older stories</a>
					{/if}
				</nav>
			{/if}
		</div>
	</main>

	<ReaderFooter shell="public" />
</div>

<style>
	.browse-head {
		margin: var(--space-6) 0 var(--space-5);
	}
	.browse-title {
		font-family: var(--font-serif);
		font-size: 34px;
		font-weight: 600;
		line-height: 1.15;
		margin: 0;
	}
	.browse-lede {
		margin: var(--space-2) 0 0;
		color: var(--text-muted);
	}
	.browse-form {
		margin-bottom: var(--space-6);
	}
	.browse-search {
		display: flex;
		gap: var(--space-2);
		margin-bottom: var(--space-4);
	}
	.browse-filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
	}
	.browse-filters .field {
		min-width: 12rem;
	}
	.browse-hide {
		border: 0;
		padding: 0;
		margin: 0 0 var(--space-3);
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
	}
	.browse-hide legend {
		font-size: var(--text-sm);
		font-weight: 600;
		margin-bottom: 7px;
		padding: 0;
	}
	.check-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		cursor: pointer;
	}
	.browse-adult {
		margin-top: var(--space-2);
	}
	.browse-section-title {
		font-size: var(--text-sm);
		font-weight: 600;
		margin: 0 0 var(--space-2);
	}
	.browse-authors {
		margin-bottom: var(--space-6);
	}
	.browse-authors ul {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-5);
	}
	.browse-count {
		color: var(--text-muted);
		font-size: var(--text-sm);
		margin-left: 4px;
	}
	.browse-empty {
		color: var(--text-muted);
	}
	.browse-pages {
		display: flex;
		justify-content: space-between;
		margin: var(--space-6) 0;
	}
</style>
