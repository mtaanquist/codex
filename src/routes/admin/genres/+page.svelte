<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import CuratedList from '../CuratedList.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<CuratedList
	{data}
	{form}
	kind="genre"
	title="Genres"
	lede="The genres authors can pick for a story, up to three each. Authors choose from this list and cannot add to it."
	placeholder="Cozy fantasy&#10;Space opera"
/>
