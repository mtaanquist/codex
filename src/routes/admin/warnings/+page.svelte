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
	lede="The content warnings authors can mark on a story. Readers see them on the story page before they start reading. Authors choose from this list and cannot add to it. When you merge a warning, any Assistant content limit a writer set on it applies to the warning you merge into, with &quot;Keep it off the page&quot; winning over &quot;Write freely&quot;. Undo the merge and each warning has its own limits again. A writer who set &quot;Keep it off the page&quot; on the warning you merged into keeps it on both."
	placeholder="Animal harm&#10;Body horror"
/>
