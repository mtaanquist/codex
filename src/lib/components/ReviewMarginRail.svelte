<script lang="ts">
	import Icon from './Icon.svelte';
	import type { RailMarker } from '#lib/review-ui';

	// The margin rail of jump markers beside the review prose, shared by the
	// editor and the read-only surface. The caller computes and nudges the
	// positions (review-ui's nudgeMarkers). The markers are a pointer
	// shortcut to the notes' cards, which keyboard and screen reader users
	// reach directly, so the rail is hidden from both.
	let {
		markers,
		focusedId,
		setFocused
	}: {
		markers: RailMarker[];
		focusedId: string | null;
		setFocused: (id: string | null) => void;
	} = $props();
</script>

<div class="review-rail" aria-hidden="true">
	{#each markers as marker (marker.id)}
		<button
			class="rv-marker"
			class:is-focused={focusedId === marker.id}
			style="top: {marker.top}px; --auth: {marker.color};"
			type="button"
			tabindex="-1"
			onclick={() => setFocused(marker.id)}
			title="Jump to this note"
			aria-label="Jump to this note"
		>
			<Icon name={marker.kind === 'comment' ? 'comment' : 'suggest'} size={13} />
		</button>
	{/each}
</div>
