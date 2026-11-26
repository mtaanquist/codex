<script lang="ts">
	import { page } from '$app/state';
	import { confirmSubmit } from '#lib/confirm.svelte';
	import { actionKeepingQuery } from '#lib/href';
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
		reportId = null,
		newer = null,
		current = true,
		readable = true
	}: {
		id: string;
		title: string;
		reason?: ReportReason;
		mode?: 'takedown' | 'browse';
		// From the report queue: the report the moderator is acting on. A Browse
		// removal closes it; a takedown closes every report on the story anyway
		// and sends it only so a refusal can say the report was closed meanwhile.
		reportId?: string | null;
		// A takedown of a replaced edition takes the story's current one down
		// too: 'up' when readers can open it, 'hidden' when the writer's account
		// deletion hides it, 'closed' when readers cannot open it anyway. Posted
		// too, so the takedown is refused if a publish added one since.
		newer?: 'up' | 'hidden' | 'closed' | null;
		// Whether the edition is the story's current one, and whether readers
		// can open it right now, so the dialog says what the takedown changes.
		current?: boolean;
		readable?: boolean;
	} = $props();

	const takedown = $derived(mode === 'takedown');
	const label = $derived(takedown ? 'Take down' : 'Remove from Browse');
	const newerEffect = $derived(
		newer === 'up'
			? ' The newer edition that replaced it is taken down too, so readers can no longer open the story.'
			: newer === 'hidden'
				? " The newer edition that replaced it, which the writer's account deletion hid, is taken down too."
				: newer === 'closed'
					? ' The newer edition that replaced it is taken down too.'
					: ''
	);
	const takedownEffect = $derived(
		readable
			? 'Readers can no longer open this edition.'
			: !current
				? `This older edition is already off the public pages.${newerEffect}`
				: 'Readers cannot open this edition right now. The takedown keeps it off the public pages.'
	);
</script>

<form
	class="takedown-form"
	method="POST"
	action={actionKeepingQuery(takedown ? 'takedown' : 'removeFromBrowse', page.url.searchParams)}
	onsubmit={confirmSubmit({
		title: takedown ? `Take down "${title}"?` : `Remove "${title}" from Browse?`,
		body: takedown
			? `${takedownEffect} The author sees the reason in the story settings.`
			: 'The story leaves Browse and the author cannot list it again until you allow it. Its pages stay up. The author sees the reason in the story settings.',
		confirmLabel: label,
		danger: true
	})}
>
	<input type="hidden" name={takedown ? 'publicationId' : 'storyId'} value={id} />
	{#if reportId}<input type="hidden" name="reportId" value={reportId} />{/if}
	{#if takedown}<input type="hidden" name="newer" value={newer ? 'yes' : 'no'} />{/if}
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
	<button type="submit" class="btn btn-ghost btn-sm danger" aria-label="{label} {title}">
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
