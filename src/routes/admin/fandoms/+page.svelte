<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import CuratedList from '../CuratedList.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<CuratedList
	{data}
	{form}
	kind="fandom"
	title="Fandoms"
	lede="The existing worlds authors can pick for a story set in one. Authors choose from this list and cannot add to it."
	placeholder="Forgotten Realms&#10;Middle-earth"
/>
