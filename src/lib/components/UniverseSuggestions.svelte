<script lang="ts">
	import { tick } from 'svelte';
	import type { SubmitFunction } from '$app/forms';
	import { resolve } from '$app/paths';
	import { enhance } from '#lib/enhance';
	import { withQuery } from '#lib/href';
	import FormStatus from './FormStatus.svelte';
	import type { EntityProposalView, SplitProposalView } from '#lib/server/proposals';

	// What the Assistant or a connected app proposed for this universe and the
	// writer has not decided: entries it may be missing, and scene splits. The
	// forms post to the page's own actions (?/decideEntity, ?/decideSplit).
	let {
		entities,
		splits,
		message = '',
		done = ''
	}: {
		entities: EntityProposalView[];
		splits: SplitProposalView[];
		// The outcome of the last decision.
		message?: string;
		done?: string;
	} = $props();

	// A decision takes its row away. Focus goes to the row that takes its
	// place (or the one before, once the last is gone), and to the list's
	// heading once the list is empty, so a keyboard or screen reader user
	// carries on from where they were.
	const decide: SubmitFunction = ({ formElement }) => {
		const block = formElement.closest('.admin-block');
		const row = formElement.closest('.list-row');
		const index = row ? Array.from(block?.querySelectorAll('.list-row') ?? []).indexOf(row) : -1;
		return async ({ result, update }) => {
			await update();
			await tick();
			const lost = !document.activeElement || document.activeElement === document.body;
			if (result.type !== 'success' && !lost) return;
			const rows = block?.querySelectorAll<HTMLElement>('.list-row') ?? [];
			const next = rows[index] ?? rows[rows.length - 1];
			const target =
				next?.querySelector<HTMLElement>('button') ??
				block?.querySelector<HTMLElement>('.admin-block-title');
			target?.focus();
		};
	};

	const KIND: Record<EntityProposalView['kind'], string> = {
		character: 'Character',
		place: 'Place',
		lore: 'Lore entry'
	};
</script>

<FormStatus live error={message || null} success={done || null} />

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title" tabindex="-1">Suggested entries</h2>
		<p class="admin-block-sub">
			Characters, places and lore entries that your Assistant or a connected app found in your
			writing. Accept one to add it to this universe, or dismiss it. Nothing is added until you
			accept.
		</p>
	</div>
	{#if entities.length === 0}
		<div class="admin-card">
			<div class="empty-state tight">
				<p class="empty-state-text">No suggested entries are waiting.</p>
			</div>
		</div>
	{:else}
		<div class="admin-card tight">
			<div class="attn-list">
				{#each entities as entry (entry.id)}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">{entry.name}</div>
							<div class="list-sub">{KIND[entry.kind]}. Suggested by {entry.from}.</div>
							{#if entry.description}
								<div class="list-sub keep-lines">{entry.description}</div>
							{/if}
							{#if entry.seenIn}
								<div class="list-sub">Seen in: {entry.seenIn}</div>
							{/if}
						</div>
						<form method="POST" action="?/decideEntity" class="list-actions" use:enhance={decide}>
							<input type="hidden" name="id" value={entry.id} />
							<button
								type="submit"
								name="decision"
								value="accept"
								class="btn btn-primary btn-sm"
								aria-label="Accept {entry.name}">Accept</button
							>
							<button
								type="submit"
								name="decision"
								value="dismiss"
								class="btn btn-ghost btn-sm"
								aria-label="Dismiss {entry.name}">Dismiss</button
							>
						</form>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title" tabindex="-1">Proposed scene splits</h2>
		<p class="admin-block-sub">
			Places where a connected app thinks a scene should become two. Select "Split here" to split
			the scene at the quoted words, or dismiss the proposal. The scene stays as it is until you
			split it.
		</p>
	</div>
	{#if splits.length === 0}
		<div class="admin-card">
			<div class="empty-state tight">
				<p class="empty-state-text">No proposed splits are waiting.</p>
			</div>
		</div>
	{:else}
		<div class="admin-card tight">
			<div class="attn-list">
				{#each splits as split (split.id)}
					{@const sceneName = split.sceneTitle ?? 'Untitled scene'}
					<div class="list-row">
						<div class="list-main">
							<div class="list-title">
								<a
									href={withQuery(resolve('/stories/[id]', { id: split.storyId }), {
										scene: split.sceneId
									})}>{sceneName}</a
								>
								in {split.storyTitle}
							</div>
							<div class="list-sub">Proposed by {split.from}.</div>
							{#if split.rationale}
								<div class="list-sub">{split.rationale}</div>
							{/if}
							<div class="list-sub">The new scene would start at: "{split.before}"</div>
						</div>
						<form method="POST" action="?/decideSplit" class="list-actions" use:enhance={decide}>
							<input type="hidden" name="id" value={split.id} />
							<button
								type="submit"
								name="decision"
								value="confirm"
								class="btn btn-primary btn-sm"
								aria-label="Split here: {sceneName}">Split here</button
							>
							<button
								type="submit"
								name="decision"
								value="dismiss"
								class="btn btn-ghost btn-sm"
								aria-label="Dismiss the split of {sceneName}">Dismiss</button
							>
						</form>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	/* A description is plain text that may come in several lines. */
	.keep-lines {
		white-space: pre-line;
	}
</style>
