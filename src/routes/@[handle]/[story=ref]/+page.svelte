<script lang="ts">
	import { chapterLabels } from '#lib/chapter-role';
	import { page } from '$app/state';
	import { withQuery } from '#lib/href';
	import { resolve } from '$app/paths';
	import { renderPublicMarkdown } from '#lib/markdown';
	import AppBar from '#lib/components/AppBar.svelte';
	import ReaderFooter from '#lib/components/ReaderFooter.svelte';
	import StoryLabels from '#lib/components/StoryLabels.svelte';
	import ShelfGrid from '#lib/components/ShelfGrid.svelte';
	import { browseAdult } from '#lib/browse-adult.svelte';
	import { pageCrumb } from '#lib/chrome';
	import { formatLongDate, formatNumber } from '#lib/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const shelfHref = $derived(resolve('/@[handle]', { handle: data.handle }));
	const reportHref = $derived(
		resolve('/@[handle]/[story=ref]/report', { handle: data.handle, story: data.story })
	);
	// One address for search engines whether the reader came by id or by slug.
	const canonical = $derived(
		page.url.origin + resolve('/@[handle]/[story=ref]', { handle: data.handle, story: data.story })
	);

	type Book = NonNullable<Extract<PageData, { gate: false }>['similar']>[number];
	// A reader who chose to include adult work in Browse gets it among the
	// similar stories too. The server cannot read that choice, so the list is
	// fetched again with it, and shown for the page it was fetched for.
	let withAdult = $state<{ path: string; books: Book[] } | null>(null);
	const similar = $derived(
		data.gate ? null : withAdult?.path === page.url.pathname ? withAdult.books : data.similar
	);
	$effect(() => {
		if (data.gate || data.similar === null || data.similarAdult || !browseAdult.remembered) return;
		const path = page.url.pathname;
		const controller = new AbortController();
		const url = withQuery(
			resolve('/@[handle]/[story=ref]/similar', { handle: data.handle, story: data.story }),
			{ adult: 'show' }
		);
		fetch(url, { signal: controller.signal })
			.then((response) => (response.ok ? response.json() : null))
			.then((body: { books: (Omit<Book, 'publishedAt'> & { publishedAt: string })[] } | null) => {
				if (!body) return;
				withAdult = {
					path,
					books: body.books.map((book) => ({ ...book, publishedAt: new Date(book.publishedAt) }))
				};
			})
			// The list without adult work stays.
			.catch(() => {});
		return () => controller.abort();
	});

	// Every chapter of the edition in one list, unfiled scenes last, so the
	// contents and the prose below it are built from the same thing.
	const chapterNames = $derived(data.gate ? [] : chapterLabels(data.content.chapters));
	const chapters = $derived(
		data.gate
			? []
			: [
					...data.content.chapters.map((chapter, index) => ({
						id: `chapter-${index}`,
						title: chapterNames[index],
						scenes: chapter.scenes
					})),
					...(data.content.unfiled.length > 0
						? [
								{
									id: 'chapter-unfiled',
									title: 'Unfiled scenes',
									scenes: data.content.unfiled
								}
							]
						: [])
				]
	);
</script>

<svelte:head>
	<title>{data.title} - by {data.author}</title>
	<link rel="canonical" href={canonical} />
	{#if data.gate || data.isAdult || !data.listed}
		<meta name="robots" content="noindex" />
	{/if}
</svelte:head>

<div class="reader-shell">
	<AppBar
		shell="reader"
		crumbs={[{ kind: 'link', label: data.author, href: shelfHref }, pageCrumb(data.title)]}
		pathLabel="What you are reading"
		helpTopic="publishing"
		helpLabel="reading pages"
	/>

	<main id="main" class="reader-main">
		{#if data.gate}
			<div class="reader-col">
				<p class="reader-kicker">A story by <a href={shelfHref}>{data.author}</a></p>
				<h1 class="reader-title">{data.title}</h1>
				<p class="reader-byline">The author marked this story as adult content.</p>
				<StoryLabels {...data.labels} />
				<p class="reader-byline">
					<a
						href={withQuery(
							resolve('/@[handle]/[story=ref]', { handle: data.handle, story: data.story }),
							{ adult: 'ok' }
						)}
					>
						I am of legal age to view this content where I live; show the story
					</a>
				</p>
				<p class="reader-byline"><a href={shelfHref}>Back to the shelf</a></p>
			</div>
		{:else}
			<div class="reader-col">
				<p class="reader-kicker">
					A story by <a href={shelfHref}>{data.author}</a>{#if data.universe}, in
						<a
							href={resolve('/@[handle]/universes/[universe=ref]', {
								handle: data.handle,
								universe: data.universe.slug
							})}
						>
							{data.universe.name}
						</a>{/if}
				</p>
				<h1 class="reader-title">{data.title}</h1>
				<p class="reader-byline">
					{chapters.length}
					{chapters.length === 1 ? 'chapter' : 'chapters'} - {formatNumber(data.words)} words - published
					{formatLongDate(data.publishedAt, page.data.timeZone)}{#if data.versionLabel}
						- {data.versionLabel}{/if}
				</p>
				<StoryLabels {...data.labels} adult={data.isAdult} />

				{#if data.descriptionMd}
					<!-- Author markdown; renderPublicMarkdown escapes raw HTML and loads only Codex images. -->
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<div class="reader-brief">{@html renderPublicMarkdown(data.descriptionMd)}</div>
				{/if}

				{#if data.downloads.length > 0}
					<p class="reader-byline">
						Download:
						{#each data.downloads as artifact (artifact.id)}
							<a href={resolve('/artifacts/[id=uuid]', { id: artifact.id })} download>
								{artifact.format === 'epub' ? 'EPUB' : 'PDF'}
							</a>
						{/each}
					</p>
				{/if}

				{#if chapters.length > 1}
					<nav class="reader-toc" aria-label="Chapters">
						<div class="reader-toc-label">Contents</div>
						{#each chapters as chapter, index (chapter.id)}
							<a href="#{chapter.id}">{index + 1}. {chapter.title}</a>
						{/each}
					</nav>
				{/if}

				{#each chapters as chapter, index (chapter.id)}
					<h2 class="reader-chapter" id={chapter.id}>{index + 1}. {chapter.title}</h2>
					<div class="reader-prose">
						{#each chapter.scenes as scene, si (si)}
							{#if si > 0}<p class="break">* * *</p>{/if}
							<!-- The shared renderer escapes raw HTML, so this is the
							     author's words only. -->
							<!-- eslint-disable-next-line svelte/no-at-html-tags -->
							{@html renderPublicMarkdown(scene.bodyMd)}
						{/each}
					</div>
				{/each}
			</div>
			{#if similar && similar.length > 0}
				<section class="reader-col wide" aria-labelledby="similar-stories">
					<h2 class="shelf-label" id="similar-stories">Similar stories</h2>
					<ShelfGrid books={similar} />
				</section>
			{/if}
		{/if}
	</main>

	<ReaderFooter author={data.author} {shelfHref} {reportHref} />
</div>
