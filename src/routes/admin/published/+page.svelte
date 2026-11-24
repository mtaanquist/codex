<script lang="ts">
	import { page } from '$app/state';
	import type { PageData, ActionData } from './$types';
	import { formatDate } from '#lib/format';
	import TakedownForm from '../TakedownForm.svelte';
	import { reportReasonLabel } from '#lib/report-reasons';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const liveEditions = $derived(data.published.filter((e) => !e.removedAt));
	const takenDown = $derived(data.published.filter((e) => e.removedAt && e.isCurrent));
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Moderation</p>
	<h1 class="admin-title">Published editions</h1>
	<p class="admin-lede">
		Everything writers have made public. Take an edition down to remove it from the public pages.
		Reports from readers are under Reports.
	</p>
</div>

{#if form?.scope === 'published' && form.message}
	<div
		class="status-banner"
		style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
	>
		<span class="x">{form.message}</span>
	</div>
{/if}

<div class="admin-block">
	{#if liveEditions.length === 0}
		<div class="admin-card">
			<p class="admin-block-sub" style="margin:0;">Nothing is published right now.</p>
		</div>
	{:else}
		<div class="admin-card tight">
			<div class="attn-list">
				{#each liveEditions as edition (edition.id)}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">
								@{edition.handle}/{edition.title}
								<span class="pill">{edition.isCurrent ? 'current' : 'superseded'}</span>
								{#if edition.isAdult}<span class="pill">adult</span>{/if}
								{#if edition.isCurrent && edition.listedInBrowse}<span class="pill"
										>listed in Browse</span
									>{/if}
								{#if edition.isCurrent && edition.browseBlockedAt}<span class="pill"
										>removed from Browse</span
									>{/if}
							</div>
							<div class="list-sub">
								published {formatDate(edition.publishedAt, page.data.timeZone)}
							</div>
						</div>
						<div class="list-actions">
							<TakedownForm id={edition.id} title={edition.title} />
							{#if edition.isCurrent && edition.listedInBrowse}
								<TakedownForm mode="browse" id={edition.storyId} title={edition.title} />
							{:else if edition.isCurrent && edition.browseBlockedAt}
								<form method="POST" action="?/allowInBrowse">
									<input type="hidden" name="storyId" value={edition.storyId} />
									<button
										type="submit"
										class="btn btn-ghost btn-sm"
										aria-label="Allow {edition.title} in Browse again">Allow in Browse again</button
									>
								</form>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

{#if takenDown.length > 0}
	<div class="admin-block">
		<div class="admin-block-head">
			<h2 class="admin-block-title">Taken down</h2>
			<p class="admin-block-sub">
				The writer cannot publish these stories again until you restore the edition.
			</p>
		</div>
		<div class="admin-card tight">
			<div class="attn-list">
				{#each takenDown as edition (edition.id)}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">@{edition.handle}/{edition.title}</div>
							<div class="list-sub">
								taken down {formatDate(edition.removedAt!, page.data.timeZone)}, reason: {reportReasonLabel(
									edition.removedReason
								)}
							</div>
						</div>
						<div class="list-actions">
							<form method="POST" action="?/restore">
								<input type="hidden" name="publicationId" value={edition.id} />
								<button
									type="submit"
									class="btn btn-ghost btn-sm"
									aria-label="Restore {edition.title}">Restore</button
								>
							</form>
						</div>
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}
