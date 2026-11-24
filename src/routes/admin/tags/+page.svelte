<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import TagList from '../TagList.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Moderation</p>
	<h1 class="admin-title">Tags</h1>
	<p class="admin-lede">
		The tags authors put on their stories. Merge a typo or a short form into the tag it means, and
		every story with it shows the other one; undo the merge to split them again. Removing a tag
		hides it from every story, and authors cannot add it again.
	</p>
</div>

<div class="admin-block">
	<TagList
		list={data.list}
		query={data.query}
		kind="tag"
		message={form?.scope === 'tags' && 'message' in form ? (form.message ?? null) : null}
	/>
</div>
