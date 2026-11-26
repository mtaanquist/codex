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
	lede="The content warnings authors can mark on a story. Readers see them on the story page before they start reading. Authors choose from this list and cannot add to it. When you merge a warning, any &quot;Keep it off the page&quot; Assistant limit a writer set on it is copied to the warning you merge into, and it stays if you undo the merge."
	placeholder="Animal harm&#10;Body horror"
/>
