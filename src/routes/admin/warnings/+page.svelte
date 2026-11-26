<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import CuratedList from '../CuratedList.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<CuratedList
	{data}
	{form}
	kind="warning"
	title="Content warnings"
	lede="The content warnings authors can mark on a story. Readers see them on the story page before they start reading. Authors choose from this list and cannot add to it. Writers can also set Assistant content limits by warning: merging a warning moves those limits to the warning you merge into, and they stay there if you undo the merge."
	placeholder="Animal harm&#10;Body horror"
/>
