<script lang="ts">
	import { confirmSubmit } from '#lib/confirm.svelte';
	import { REPORT_REASONS, type ReportReason } from '#lib/report-reasons';

	// Take an edition down, or take a story off Browse, with the reason the
	// author will see. Shared by the Published and Reports pages, which both
	// have the takedown and removeFromBrowse actions. The id is the edition's
	// for a takedown and the story's for Browse.
	let {
		id,
		title,
		reason = 'other',
		mode = 'takedown',
		reportId = null
	}: {
		id: string;
		title: string;
		reason?: ReportReason;
		mode?: 'takedown' | 'browse';
		// From the report queue: the report a Browse removal answers, which closes.
		reportId?: string | null;
	} = $props();

	const takedown = $derived(mode === 'takedown');
	const label = $derived(takedown ? 'Take down' : 'Remove from Browse');
</script>

<form
	class="takedown-form"
	method="POST"
	action={takedown ? '?/takedown' : '?/removeFromBrowse'}
	onsubmit={confirmSubmit({
		title: takedown ? `Take down "${title}"?` : `Remove "${title}" from Browse?`,
		body: takedown
			? 'Readers can no longer open this edition. The author sees the reason in the story settings.'
			: 'The story leaves Browse and the author cannot list it again until you allow it. Its pages stay up. The author sees the reason in the story settings.',
		confirmLabel: label,
		danger: true
	})}
>
	<input type="hidden" name={takedown ? 'publicationId' : 'storyId'} value={id} />
	{#if reportId}<input type="hidden" name="reportId" value={reportId} />{/if}
	<select
		class="select"
		name="reason"
		aria-label="{takedown ? 'Reason for taking down' : 'Reason for removing from Browse'} {title}"
		value={reason}
	>
		{#each REPORT_REASONS as option (option.key)}
			<option value={option.key}>{option.label}</option>
		{/each}
	</select>
	<button
		type="submit"
		class="btn btn-ghost btn-sm"
		style="color:var(--danger-ink);"
		aria-label="{label} {title}"
	>
		{label}
	</button>
</form>

<style>
	.takedown-form {
		display: flex;
		gap: 7px;
		align-items: center;
	}
	.takedown-form .select {
		width: auto;
		max-width: 16rem;
		height: 30px;
		font-size: var(--text-sm);
	}
</style>
