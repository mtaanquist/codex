<script lang="ts">
	import Icon from './Icon.svelte';

	// Shown in a scene editor when a pasted or dropped image was not added,
	// with the reason the server gave.
	let { message, onDismiss }: { message: string; onDismiss: () => void } = $props();
</script>

<div class="revision-banner" role="alert">
	<div class="revision-banner-icon"><Icon name="close" size={16} /></div>
	<div class="revision-banner-main">
		<div class="revision-banner-title">The image was not added</div>
		<div class="revision-banner-sub">{message}</div>
	</div>
	<div class="revision-banner-actions">
		<button class="btn btn-sm btn-secondary" type="button" onclick={onDismiss}>Dismiss</button>
	</div>
</div>
