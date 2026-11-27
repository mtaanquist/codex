<script lang="ts" module>
	// Right-click menu for sidebar rows: chapter tools or the scene actions.
	import type { ChapterRole } from '#lib/chapter-role';
	export type RowMenuTarget =
		| { kind: 'chapter'; id: string; index: number; role: ChapterRole | null }
		| { kind: 'scene'; id: string };
	export type RowMenuState = { x: number; y: number; target: RowMenuTarget };
</script>

<script lang="ts">
	import { confirmSubmit } from '#lib/confirm.svelte';
	import type { SvelteSet } from 'svelte/reactivity';
	import { enhance } from '#lib/enhance';
	import Icon from './Icon.svelte';
	import { dismiss } from '#lib/dismiss';
	import { menu as menuKeys } from '#lib/menu';
	import { CHAPTER_ROLES, CHAPTER_ROLE_LABELS, REGULAR_CHAPTER_LABEL } from '#lib/chapter-role';

	let {
		menu,
		chapterCount,
		assistantEnabled,
		selectedSceneId,
		mergeSelection,
		onClose,
		onRenameChapter,
		onOpenReview,
		onSuggestSplit,
		onDraftScene,
		onDraftChapter,
		onDuplicateScene,
		onMergeSelected,
		onFindReplace
	}: {
		menu: RowMenuState;
		chapterCount: number;
		assistantEnabled: boolean;
		// Sidebar actions reload the page; carrying the open scene keeps it open.
		selectedSceneId: string | null;
		// Shared with the outline, which highlights the picked rows.
		mergeSelection: SvelteSet<string>;
		onClose: (refocus?: boolean) => void;
		onRenameChapter: (chapterId: string) => void;
		// Opens the review modal for the picked scene or chapter.
		onOpenReview: (request: { sceneId?: string; chapterId?: string }) => void;
		// Write only: Review's Assistant tab cannot confirm a split proposal.
		onSuggestSplit?: (sceneId: string) => void;
		// Write only: opens the scene draft form in the Assistant panel.
		onDraftScene?: (sceneId: string) => void;
		// Write only: opens the chapter draft form in the Assistant panel.
		onDraftChapter?: (chapterId: string) => void;
		onDuplicateScene: (sceneId: string) => void;
		onMergeSelected: () => void;
		// Write only: opens find and replace across the chapter.
		onFindReplace?: (chapterId: string) => void;
	} = $props();

	const target = $derived(menu.target);

	// Management forms refresh in place rather than reloading the page; the menu
	// closes once the action lands. The two confirm-guarded forms (delete chapter,
	// delete forever) keep the plain submit, where a reload is fine.
	const closeAfter = () => async (result: { update: () => Promise<void> }) => {
		await result.update();
		onClose();
	};

	// The flyout open inside the menu, if any.
	let subOpen = $state<'assistant' | 'role' | null>(null);
	const roleChoices = [
		{ value: '', label: REGULAR_CHAPTER_LABEL },
		...CHAPTER_ROLES.map((role) => ({ value: role, label: CHAPTER_ROLE_LABELS[role] }))
	];

	function toggleMergeSelection(sceneId: string) {
		if (mergeSelection.has(sceneId)) mergeSelection.delete(sceneId);
		else mergeSelection.add(sceneId);
		onClose();
	}
</script>

{#snippet openSceneField()}
	{#if selectedSceneId}
		<input type="hidden" name="openSceneId" value={selectedSceneId} />
	{/if}
{/snippet}

<div
	class="row-menu popover"
	role="menu"
	use:dismiss={{ close: () => onClose(), refocus: () => onClose(true) }}
	use:menuKeys={{ close: () => onClose(), refocus: () => onClose(true) }}
	style="left: {menu.x}px; top: {menu.y}px;"
>
	{#if target.kind === 'chapter'}
		<button
			class="menu-item"
			type="button"
			role="menuitem"
			onclick={() => onRenameChapter(target.id)}
		>
			<Icon name="pencil" size={13} /> Rename chapter
		</button>
		{#if onFindReplace}
			<button
				class="menu-item"
				type="button"
				role="menuitem"
				onclick={() => onFindReplace(target.id)}
			>
				<Icon name="search" size={13} /> Find and replace in chapter...
			</button>
		{/if}
		{#if assistantEnabled}
			<div
				class="row-sub"
				role="presentation"
				onmouseenter={() => (subOpen = 'assistant')}
				onmouseleave={(event) => {
					// Keyboard focus inside the flyout keeps it open.
					if (!event.currentTarget.contains(document.activeElement)) subOpen = null;
				}}
			>
				<button
					class="menu-item row-sub-trigger"
					type="button"
					role="menuitem"
					aria-haspopup="menu"
					aria-expanded={subOpen === 'assistant'}
					onclick={() => (subOpen = subOpen === 'assistant' ? null : 'assistant')}
				>
					<span class="row-sub-label"><Icon name="sparkles" size={13} /> Assistant</span>
					<Icon name="chevron" size={12} />
				</button>
				{#if subOpen === 'assistant'}
					<div class="row-submenu popover" role="menu">
						<button
							class="menu-item"
							type="button"
							role="menuitem"
							onclick={() => onOpenReview({ chapterId: target.id })}
						>
							Review with the Assistant...
						</button>
						{#if onDraftChapter}
							<button
								class="menu-item"
								type="button"
								role="menuitem"
								onclick={() => onDraftChapter(target.id)}
							>
								Draft this chapter...
							</button>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
		<div
			class="row-sub"
			role="presentation"
			onmouseenter={() => (subOpen = 'role')}
			onmouseleave={(event) => {
				if (!event.currentTarget.contains(document.activeElement)) subOpen = null;
			}}
		>
			<button
				class="menu-item row-sub-trigger"
				type="button"
				role="menuitem"
				aria-haspopup="menu"
				aria-expanded={subOpen === 'role'}
				onclick={() => (subOpen = subOpen === 'role' ? null : 'role')}
			>
				<span class="row-sub-label"><Icon name="chapter" size={13} /> Chapter type</span>
				<Icon name="chevron" size={12} />
			</button>
			{#if subOpen === 'role'}
				<div class="row-submenu popover" role="menu" aria-label="Chapter type">
					{#each roleChoices as choice (choice.value)}
						{@const current = (target.role ?? '') === choice.value}
						<form method="POST" action="?/setChapterRole" use:enhance={closeAfter}>
							<input type="hidden" name="chapterId" value={target.id} />
							<input type="hidden" name="role" value={choice.value} />
							{@render openSceneField()}
							<button
								class="menu-item role-choice"
								type="submit"
								role="menuitemradio"
								aria-checked={current}
							>
								<span>{choice.label}</span>
								{#if current}<Icon name="check" size={13} />{/if}
							</button>
						</form>
					{/each}
				</div>
			{/if}
		</div>
		<form method="POST" action="?/moveChapter" use:enhance={closeAfter}>
			<input type="hidden" name="chapterId" value={target.id} />
			<input type="hidden" name="direction" value="up" />
			{@render openSceneField()}
			<button class="menu-item turn-up" type="submit" role="menuitem" disabled={target.index === 0}>
				<Icon name="chevron" size={13} /> Move up
			</button>
		</form>
		<form method="POST" action="?/moveChapter" use:enhance={closeAfter}>
			<input type="hidden" name="chapterId" value={target.id} />
			<input type="hidden" name="direction" value="down" />
			{@render openSceneField()}
			<button
				class="menu-item turn-down"
				type="submit"
				role="menuitem"
				disabled={target.index === chapterCount - 1}
			>
				<Icon name="chevron" size={13} /> Move down
			</button>
		</form>
		<form
			method="POST"
			action="?/deleteChapter"
			onsubmit={confirmSubmit({
				title: 'Delete this chapter?',
				body: 'Its scenes move to Unfiled scenes.',
				confirmLabel: 'Delete chapter',
				danger: true
			})}
		>
			<input type="hidden" name="chapterId" value={target.id} />
			{@render openSceneField()}
			<button class="menu-item danger" type="submit" role="menuitem">
				<Icon name="trash" size={13} /> Delete chapter
			</button>
		</form>
	{:else}
		{@const pickedForMerge = mergeSelection.has(target.id)}
		<button
			class="menu-item"
			type="button"
			role="menuitem"
			onclick={() => toggleMergeSelection(target.id)}
		>
			<Icon name="plus" size={13} />
			{pickedForMerge ? 'Unselect for merging' : 'Select for merging'}
		</button>
		<button
			class="menu-item"
			type="button"
			role="menuitem"
			onclick={() => onDuplicateScene(target.id)}
		>
			<Icon name="copy" size={13} /> Duplicate scene
		</button>
		{#if assistantEnabled}
			<div
				class="row-sub"
				role="presentation"
				onmouseenter={() => (subOpen = 'assistant')}
				onmouseleave={(event) => {
					// Keyboard focus inside the flyout keeps it open.
					if (!event.currentTarget.contains(document.activeElement)) subOpen = null;
				}}
			>
				<button
					class="menu-item row-sub-trigger"
					type="button"
					role="menuitem"
					aria-haspopup="menu"
					aria-expanded={subOpen === 'assistant'}
					onclick={() => (subOpen = subOpen === 'assistant' ? null : 'assistant')}
				>
					<span class="row-sub-label"><Icon name="sparkles" size={13} /> Assistant</span>
					<Icon name="chevron" size={12} />
				</button>
				{#if subOpen === 'assistant'}
					<div class="row-submenu popover" role="menu">
						<button
							class="menu-item"
							type="button"
							role="menuitem"
							onclick={() => onOpenReview({ sceneId: target.id })}
						>
							Review with the Assistant...
						</button>
						{#if onSuggestSplit}
							<button
								class="menu-item"
								type="button"
								role="menuitem"
								onclick={() => onSuggestSplit(target.id)}
							>
								Suggest where to split
							</button>
						{/if}
						{#if onDraftScene}
							<button
								class="menu-item"
								type="button"
								role="menuitem"
								onclick={() => onDraftScene(target.id)}
							>
								Draft this scene...
							</button>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
		{#if pickedForMerge && mergeSelection.size >= 2}
			<button class="menu-item" type="button" role="menuitem" onclick={onMergeSelected}>
				<Icon name="chapter" size={13} /> Merge {mergeSelection.size} scenes
			</button>
		{/if}
		{#if mergeSelection.size > 0}
			<button
				class="menu-item"
				type="button"
				role="menuitem"
				onclick={() => {
					mergeSelection.clear();
					onClose();
				}}
			>
				Clear merge selection
			</button>
		{/if}
		<form method="POST" action="?/deleteScene" use:enhance={closeAfter}>
			<input type="hidden" name="sceneId" value={target.id} />
			{@render openSceneField()}
			<button class="menu-item danger" type="submit" role="menuitem">
				<Icon name="trash" size={13} /> Delete scene
			</button>
		</form>
	{/if}
</div>

<style>
	/* Skin from the shared .popover / .menu-item (menus.css); only the
	   positioning and the flyout structure stay here. */
	.row-menu {
		position: fixed;
		z-index: 60;
		min-width: 170px;
	}
	/* The Assistant flyout, the editor selection menu's submenu pattern. */
	.row-sub {
		position: relative;
	}
	.row-sub-trigger {
		justify-content: space-between;
	}
	.row-sub-label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.row-submenu {
		position: absolute;
		left: calc(100% - 2px);
		top: -7px;
		min-width: 180px;
		z-index: 61;
	}
	.role-choice {
		justify-content: space-between;
	}
	.turn-up :global(svg) {
		transform: rotate(-90deg);
	}
	.turn-down :global(svg) {
		transform: rotate(90deg);
	}
</style>
