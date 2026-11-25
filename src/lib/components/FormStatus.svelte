<script lang="ts">
	import { failedSaves, NOT_SAVED } from '#lib/autosave-form';

	// The inline save-feedback line that sits in a settings form's action row:
	// an error in the danger colour, or a success note in the final-status
	// colour. The caller passes the already-narrowed strings (which scope/action
	// matched). In an autosaving form whose last save errored, the first
	// FormStatus in the form says so in place of either.
	let {
		error: givenError = null,
		success: givenSuccess = null,
		block = false,
		live = false
	}: {
		error?: string | null;
		success?: string | null;
		// Some rows render the message as a block paragraph rather than inline.
		block?: boolean;
		// For a message that changes without a page load (an enhanced form):
		// the status region stays in the page while empty, so each new message
		// is read out by screen readers. Implies block.
		live?: boolean;
	} = $props();

	let marker = $state<HTMLElement>();
	const form = $derived(marker?.closest('form'));
	const failed = $derived(
		!!form && failedSaves.has(form) && form.querySelector('[data-form-status]') === marker
	);
	const error = $derived(failed ? NOT_SAVED : givenError);
	const success = $derived(failed ? null : givenSuccess);
</script>

<span hidden data-form-status bind:this={marker}></span>

{#if live}
	<div role="status">
		{#if error}
			<p class="field-hint fs-error">{error}</p>
		{:else if success}
			<p class="field-hint fs-ok">{success}</p>
		{/if}
	</div>
{:else if error}
	{#if block}
		<p class="field-hint fs-error" role="alert">{error}</p>
	{:else}
		<span class="field-hint fs-error" role="alert">{error}</span>
	{/if}
{:else if success}
	{#if block}
		<p class="field-hint fs-ok" role="status">{success}</p>
	{:else}
		<span class="field-hint fs-ok" role="status">{success}</span>
	{/if}
{/if}

<style>
	.fs-error {
		color: var(--danger-ink);
	}
	.fs-ok {
		color: var(--status-final-ink);
	}
</style>
