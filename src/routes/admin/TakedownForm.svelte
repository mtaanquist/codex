<script lang="ts">
	import { confirmSubmit } from '#lib/confirm.svelte';
	import { REPORT_REASONS, type ReportReason } from '#lib/report-reasons';

	// Take an edition down, with the reason the author will see. Shared by the
	// Published and Reports pages, which both have a takedown action.
	let {
		publicationId,
		title,
		reason = 'other'
	}: { publicationId: string; title: string; reason?: ReportReason } = $props();
</script>

<form
	class="takedown-form"
	method="POST"
	action="?/takedown"
	onsubmit={confirmSubmit({
		title: `Take down "${title}"?`,
		body: 'Readers can no longer open this edition. The author sees the reason in the story settings.',
		confirmLabel: 'Take down',
		danger: true
	})}
>
	<input type="hidden" name="publicationId" value={publicationId} />
	<select class="select" name="reason" aria-label="Reason for taking down {title}" value={reason}>
		{#each REPORT_REASONS as option (option.key)}
			<option value={option.key}>{option.label}</option>
		{/each}
	</select>
	<button type="submit" class="btn btn-ghost btn-sm" style="color:var(--danger-ink);"
		>Take down</button
	>
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
