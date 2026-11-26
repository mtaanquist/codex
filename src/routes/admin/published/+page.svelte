<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { PageData, ActionData } from './$types';
	import { actionKeepingQuery, withQuery } from '#lib/href';
	import { formatDate, formatNumber } from '#lib/format';
	import TakedownForm from '../TakedownForm.svelte';
	import { moderationEditionName, moderationRowName, reportReasonLabel } from '#lib/report-reasons';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const query = $derived(page.url.searchParams.get('q') ?? '');
	function livePageHref(n: number) {
		return withQuery(resolve('/admin/published'), { q: query, page: n > 0 ? n : null });
	}
	function editionHref(id: string) {
		return resolve('/admin/published/[id=uuid]', { id });
	}
	// The moderator who acted, when their account still exists.
	function byName(name: string | null) {
		return name ? ` by ${name}` : '';
	}
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Moderation</p>
	<h1 class="admin-title">Published editions</h1>
	<p class="admin-lede">
		The latest edition of every story writers have published, unless it is taken down. That includes
		editions hidden by an account deletion. An edition you cannot open, such as one of a story the
		writer made private or moved to the trash, shows only the writer's handle. Take an edition down
		to remove it from the public pages. Open a linked title to read the edition. Reports from
		readers are under Reports.
	</p>
</div>

{#if form?.scope === 'published' && form.message}
	<div class="status-banner error" role="alert">
		<span class="x">{form.message}</span>
	</div>
{/if}

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">
			Current editions <span class="n">{formatNumber(data.live.total)}</span>
		</h2>
	</div>
	<form method="GET" class="admin-search" role="search">
		<input
			class="input short"
			type="search"
			name="q"
			value={query}
			placeholder="Handle or title"
			aria-label="Find an edition by handle or title"
		/>
		<button type="submit" class="btn btn-secondary btn-sm">Find</button>
		{#if query}
			<a class="btn btn-ghost btn-sm" href={livePageHref(0)}>Show all</a>
		{/if}
	</form>
	{#if data.live.editions.length === 0}
		<div class="admin-card">
			<p class="admin-block-sub" style="margin:0;">
				{#if data.live.page > 0}
					No editions on this page. <a href={livePageHref(0)}>Go to the first page</a>.
				{:else}
					{query ? 'No edition matches that search.' : 'Nothing is published right now.'}
				{/if}
			</p>
		</div>
	{:else}
		<div class="admin-card tight">
			<div class="attn-list">
				{#each data.live.editions as edition (edition.id)}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">
								{#if edition.viewable}
									<a href={editionHref(edition.id)}>
										{moderationRowName(edition.handle, edition.title)}
									</a>
								{:else}
									<span title="The writer made this story private or moved it to the trash.">
										{moderationRowName(edition.handle, edition.title)}
									</span>
								{/if}
								{#if edition.hiddenAt}<span class="pill">
										{edition.ownerDeletionPending
											? 'hidden: account deletion pending'
											: 'hidden after a cancelled account deletion'}
									</span>{/if}
								{#if edition.isAdult}<span class="pill">adult</span>{/if}
								{#if edition.shownInBrowse}<span class="pill"> listed in Browse </span>{/if}
								{#if edition.browseBlockedAt}<span class="pill">removed from Browse</span>{/if}
							</div>
							<div class="list-sub">
								published {formatDate(
									edition.publishedAt,
									page.data.timeZone
								)}{#if edition.restoredAt}, last restored
									{formatDate(edition.restoredAt, page.data.timeZone)}{byName(
										edition.restoredByName
									)}{/if}{#if edition.browseAllowedAt}, last allowed in Browse
									{formatDate(edition.browseAllowedAt, page.data.timeZone)}{byName(
										edition.browseAllowedByName
									)}{/if}
							</div>
						</div>
						<div class="list-actions">
							{#if edition.viewable}
								<TakedownForm
									id={edition.id}
									title={edition.title}
									handle={edition.handle}
									readable={edition.readable}
								/>
							{/if}
							{#if edition.viewable && edition.listedInBrowse}
								<TakedownForm
									mode="browse"
									id={edition.storyId}
									title={edition.title}
									handle={edition.handle}
								/>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
	{#if data.live.page > 0 || data.live.hasMore}
		<div class="settings-actions">
			{#if data.live.page > 0}
				<a class="btn btn-ghost btn-sm" href={livePageHref(data.live.page - 1)}>Previous</a>
			{/if}
			{#if data.live.hasMore}
				<a class="btn btn-ghost btn-sm" href={livePageHref(data.live.page + 1)}>Next</a>
			{/if}
		</div>
	{/if}
</div>

{#if data.browseBlocked.length > 0}
	<div class="admin-block">
		<div class="admin-block-head">
			<h2 class="admin-block-title">Removed from Browse</h2>
			<p class="admin-block-sub">
				The writer cannot list these stories in Browse until you allow it. Removing a story from
				Browse does not take its pages down.
			</p>
		</div>
		<div class="admin-card tight">
			<div class="attn-list">
				{#each data.browseBlocked as story (story.storyId)}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">
								{#if story.title === null}
									<span title="The writer made this story private or moved it to the trash.">
										{moderationRowName(story.handle, story.title)}
									</span>
								{:else}
									{moderationRowName(story.handle, story.title)}
								{/if}
							</div>
							<div class="list-sub">
								removed {formatDate(story.browseBlockedAt!, page.data.timeZone)}{byName(
									story.browseBlockedByName
								)}, reason: {reportReasonLabel(story.browseBlockedReason)}
							</div>
						</div>
						<div class="list-actions">
							<form
								method="POST"
								action={actionKeepingQuery('allowInBrowse', page.url.searchParams)}
							>
								<input type="hidden" name="storyId" value={story.storyId} />
								<input type="hidden" name="browseBlockedAt" value={story.browseBlockedMicros} />
								<button
									type="submit"
									class="btn btn-ghost btn-sm"
									aria-label="Allow {moderationEditionName(
										story.handle,
										story.title
									)} in Browse again"
								>
									Allow in Browse again
								</button>
							</form>
						</div>
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}

{#if data.takenDown.length > 0}
	<div class="admin-block">
		<div class="admin-block-head">
			<h2 class="admin-block-title">Taken down</h2>
			<p class="admin-block-sub">
				The writer cannot publish these stories again until you restore the edition. Restoring lifts
				the takedown from every edition of the story.
			</p>
		</div>
		<div class="admin-card tight">
			<div class="attn-list">
				{#each data.takenDown as edition (edition.id)}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">
								{#if edition.viewable}
									<a href={editionHref(edition.id)}>
										{moderationRowName(edition.handle, edition.title)}
									</a>
								{:else}
									<span
										title={edition.notViewableBecause === 'olderTakedown'
											? 'The story is private or in the trash, and older takedowns like this one cannot be opened here.'
											: 'The writer made this story private or moved it to the trash.'}
									>
										{moderationRowName(edition.handle, edition.title)}
									</span>
								{/if}
							</div>
							<div class="list-sub">
								taken down {formatDate(edition.takenDownAt!, page.data.timeZone)}{byName(
									edition.removedByName
								)}, reason: {reportReasonLabel(edition.removedReason)}
							</div>
							{#if edition.ownerDeletionPending}
								<div class="list-sub">
									The writer asked to delete their account. You can restore this edition only if the
									deletion is cancelled.
								</div>
							{:else if edition.hiddenByAccountDeletion}
								<div class="list-sub">
									The writer's account deletion was cancelled. Restoring lets them publish again but
									keeps this edition hidden.
								</div>
							{/if}
						</div>
						<div class="list-actions">
							<form method="POST" action={actionKeepingQuery('restore', page.url.searchParams)}>
								<input type="hidden" name="publicationId" value={edition.id} />
								<input type="hidden" name="takenDownAt" value={edition.takenDownMicros} />
								<button
									type="submit"
									class="btn btn-ghost btn-sm"
									aria-label="Restore {moderationEditionName(edition.handle, edition.title)}"
								>
									Restore
								</button>
							</form>
						</div>
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}
