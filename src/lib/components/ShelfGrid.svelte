<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { renderMarkdown } from '#lib/markdown';
	import { formatLongDate } from '#lib/format';
	import { slugAddress } from '#lib/slug';

	// The covers on a public shelf: the author's shelf and a universe page.
	// Each links to the story's reading page by its slug (see slugAddress).
	type Book = {
		storyId: string;
		slug: string;
		title: string;
		descriptionMd: string | null;
		isAdult: boolean;
		publishedAt: Date;
		coverAssetId: string | null;
		coverColor: string;
	};

	let { handle, books }: { handle: string; books: Book[] } = $props();
</script>

<ul class="shelf-grid">
	{#each books as book (book.storyId)}
		<li>
			<a
				class="shelf-item"
				href={resolve('/@[handle]/[story=ref]', {
					handle,
					story: slugAddress({ id: book.storyId, slug: book.slug })
				})}
			>
				<!-- A cover is the story's own title, set on the story's
				     colour, until an author uploads artwork. Hidden from
				     readers because the title repeats right below. -->
				{#if book.coverAssetId}
					<span class="shelf-cover">
						<img src="/assets/{book.coverAssetId}" alt="" />
					</span>
				{:else}
					<span
						class="shelf-cover shelf-cover-tinted"
						style="--cover-tint: {book.coverColor}"
						aria-hidden="true"
					>
						{book.title}
					</span>
				{/if}
				<span class="shelf-item-title">{book.title}</span>
				<span class="shelf-item-meta">
					{formatLongDate(book.publishedAt, page.data.timeZone)}{#if book.isAdult}
						- adult content{/if}
				</span>
				{#if book.descriptionMd}
					<!-- Author markdown; renderMarkdown escapes raw HTML. -->
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<span class="shelf-item-brief">{@html renderMarkdown(book.descriptionMd)}</span>
				{/if}
			</a>
		</li>
	{/each}
</ul>
