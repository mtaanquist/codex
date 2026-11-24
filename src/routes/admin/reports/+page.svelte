<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { PageData, ActionData } from './$types';
	import { formatDate, formatDateTime } from '#lib/format';
	import { isReportReason, reportReasonLabel } from '#lib/report-reasons';
	import TakedownForm from '../TakedownForm.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const RESOLUTION_LABELS: Record<string, string> = {
		taken_down: 'Taken down',
		removed_from_browse: 'Removed from Browse',
		dismissed: 'Dismissed'
	};
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Moderation</p>
	<h1 class="admin-title">Reports</h1>
	<p class="admin-lede">
		What readers reported about published stories, oldest first. Take the edition down, or dismiss
		the report if nothing is wrong. Taking an edition down closes every report about the story.
		Removing a story from Browse closes only the report you acted on.
	</p>
</div>

{#if form?.scope === 'reports' && form.message}
	<div
		class="status-banner"
		style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
	>
		<span class="x">{form.message}</span>
	</div>
{/if}

<div class="admin-block">
	{#if data.reports.length === 0}
		<div class="admin-card">
			<p class="admin-block-sub" style="margin:0;">No open reports.</p>
		</div>
	{:else}
		<div class="admin-card tight">
			<div class="attn-list">
				{#each data.reports as report (report.id)}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">
								<a
									href={resolve('/@[handle]/[story=ref]', {
										handle: report.handle,
										story: report.storyId
									})}>@{report.handle}/{report.title}</a
								>
								{#if report.editionRemovedAt}<span class="pill">taken down</span>{/if}
							</div>
							<div class="list-sub">
								{reportReasonLabel(report.reason)} - reported {formatDate(
									report.createdAt,
									page.data.timeZone
								)}
							</div>
							{#if report.comment}
								<p class="user-row-note">{report.comment}</p>
							{/if}
						</div>
						<div class="list-actions">
							{#if !report.editionRemovedAt}
								<TakedownForm
									id={report.publicationId}
									title={report.title}
									reason={isReportReason(report.reason) ? report.reason : 'other'}
								/>
							{/if}
							{#if report.listedInBrowse && !report.browseBlockedAt}
								<TakedownForm
									mode="browse"
									id={report.storyId}
									reportId={report.id}
									title={report.title}
									reason={isReportReason(report.reason) ? report.reason : 'other'}
								/>
							{/if}
							<form method="POST" action="?/dismiss">
								<input type="hidden" name="reportId" value={report.id} />
								<button
									type="submit"
									class="btn btn-ghost btn-sm"
									aria-label="Dismiss report about {report.title}">Dismiss</button
								>
							</form>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

{#if data.resolved.length > 0}
	<div class="admin-block">
		<div class="admin-block-head">
			<div>
				<h2 class="admin-block-title">Recently closed</h2>
			</div>
		</div>
		<div class="admin-card tight">
			<div class="attn-list">
				{#each data.resolved as report (report.id)}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">@{report.handle}/{report.title}</div>
							<div class="list-sub">
								{reportReasonLabel(report.reason)} - {RESOLUTION_LABELS[report.resolution ?? ''] ??
									'Closed'}{report.resolvedByName ? ` by ${report.resolvedByName}` : ''}
								{#if report.resolvedAt}
									- {formatDateTime(report.resolvedAt, page.data.timeZone)}{/if}
							</div>
						</div>
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}
