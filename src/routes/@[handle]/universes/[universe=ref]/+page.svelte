<script lang="ts">
	import { resolve } from '$app/paths';
	import AppBar from '#lib/components/AppBar.svelte';
	import ReaderFooter from '#lib/components/ReaderFooter.svelte';
	import ShelfGrid from '#lib/components/ShelfGrid.svelte';
	import { pageCrumb } from '#lib/chrome';
	import { formatNumber } from '#lib/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const shelfHref = $derived(resolve('/@[handle]', { handle: data.handle }));
	// Same rule as the shelf: any adult book on the page de-indexes it.
	const hasAdult = $derived(data.shelf.some((book) => book.isAdult));
</script>

<svelte:head>
	<title>{data.name} - by {data.author}</title>
	{#if hasAdult}
		<meta name="robots" content="noindex" />
	{/if}
</svelte:head>

<div class="reader-shell">
	<AppBar
		shell="reader"
		crumbs={[{ kind: 'link', label: data.author, href: shelfHref }, pageCrumb(data.name)]}
		pathLabel="What you are reading"
		helpTopic="publishing"
		helpLabel="reading pages"
	/>

	<main id="main" class="reader-main">
		<div class="reader-col wide">
			<p class="reader-kicker">A universe by <a href={shelfHref}>{data.author}</a></p>
			<h1 class="reader-title">{data.name}</h1>
			<p class="reader-byline">
				{formatNumber(data.shelf.length)}
				{data.shelf.length === 1 ? 'story' : 'stories'} published
			</p>

			<h2 class="shelf-label">Published</h2>
			<ShelfGrid handle={data.handle} books={data.shelf} />
		</div>
	</main>

	<ReaderFooter author={data.author} {shelfHref} />
</div>
