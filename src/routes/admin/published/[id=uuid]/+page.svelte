<script lang="ts">
	import { chapterLabels } from '#lib/chapter-role';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { PageData } from './$types';
	import { formatDate } from '#lib/format';
	import { renderPublicMarkdown } from '#lib/markdown';
	import { reportReasonLabel } from '#lib/report-reasons';

	let { data }: { data: PageData } = $props();
	const edition = $derived(data.edition);
	const timeZone = $derived(page.data.timeZone);

	const chapterNames = $derived(chapterLabels(edition.content.chapters));
	const chapters = $derived([
		...edition.content.chapters.map((chapter, index) => ({
			title: chapterNames[index],
			scenes: chapter.scenes
		})),
		...(edition.content.unfiled.length > 0
			? [{ title: 'Unfiled scenes', scenes: edition.content.unfiled }]
			: [])
	]);
</script>

<div class="admin-head">
	<p class="admin-eyebrow">
		<a href={resolve('/admin/published')}>Published editions</a>
	</p>
	<h1 class="admin-title">@{edition.handle}/{edition.title}</h1>
	<p class="admin-lede">
		The text of this edition as it was published. Only admins and moderators can open this page.
	</p>
</div>

<div class="admin-block">
	<div class="admin-card">
		<p class="admin-block-sub" style="margin:0;">
			Published {formatDate(edition.publishedAt, timeZone)}{#if edition.versionLabel}
				- {edition.versionLabel}{/if}
			{#if edition.isAdult}<span class="pill">adult</span>{/if}
			{#if !edition.isCurrent}<span class="pill">replaced by a newer edition</span>{/if}
		</p>
		{#if edition.removedReason}
			<p class="admin-block-sub">
				Taken down {formatDate(edition.takenDownAt!, timeZone)}{edition.removedByName
					? ` by ${edition.removedByName}`
					: ''}, reason: {reportReasonLabel(edition.removedReason)}. Readers cannot open it.
			</p>
		{:else if edition.removedAt}
			<p class="admin-block-sub">
				{edition.ownerDeletionPending
					? 'Hidden because the writer asked to delete their account.'
					: 'Hidden since the writer cancelled an account deletion.'} Readers cannot open it.
			</p>
		{/if}
		{#if edition.restoredAt}
			<p class="admin-block-sub">
				Last restored {formatDate(edition.restoredAt, timeZone)}{edition.restoredByName
					? ` by ${edition.restoredByName}`
					: ''}.
			</p>
		{/if}
		{#if edition.contentWarnings.length > 0}
			<p class="admin-block-sub">Content warnings: {edition.contentWarnings.join(', ')}</p>
		{/if}
		{#if edition.readable}
			<p class="admin-block-sub" style="margin-bottom:0;">
				<a
					href={resolve('/@[handle]/[story=ref]', {
						handle: edition.handle,
						story: edition.storyId
					})}
				>
					Open the public page
				</a>
			</p>
		{/if}
	</div>
</div>

<div class="admin-block">
	<div class="admin-card moderator-reader">
		{#if edition.descriptionMd}
			<!-- Author markdown; renderPublicMarkdown escapes raw HTML and loads only Codex images. -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<div class="reader-brief">{@html renderPublicMarkdown(edition.descriptionMd)}</div>
		{/if}
		{#each chapters as chapter, index (index)}
			<h2 class="reader-chapter">{chapter.title}</h2>
			<div class="reader-prose">
				{#each chapter.scenes as scene, si (si)}
					{#if si > 0}<p class="break">* * *</p>{/if}
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html renderPublicMarkdown(scene.bodyMd)}
				{/each}
			</div>
		{:else}
			<p class="admin-block-sub" style="margin:0;">This edition has no text.</p>
		{/each}
	</div>
</div>

<style>
	.moderator-reader {
		background: var(--bg-canvas);
	}
</style>
