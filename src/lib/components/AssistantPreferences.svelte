<script lang="ts">
	// The "Assistant preferences" group of a story's or a universe's Details:
	// the house style, the habit checks, and the writer's own notes. On a
	// story, a blank choice uses the universe's; on a universe, the Assistant's
	// default (infer from the text, check everything).
	import FormStatus from '#lib/components/FormStatus.svelte';
	import {
		HABIT_CHECKS,
		HOUSE_STYLE,
		MAX_ASSISTANT_NOTES,
		normaliseNotes,
		normalisePreferences
	} from '#lib/assistant-preferences';

	let {
		level,
		stored,
		notes,
		inherited = null,
		saved = false,
		error = null
	}: {
		level: 'story' | 'universe';
		stored: unknown;
		notes: string | null;
		// The universe's preferences, for a story in a universe; null for a
		// universe or a standalone story.
		inherited?: { preferences: unknown; notes: string | null } | null;
		saved?: boolean;
		error?: string | null;
	} = $props();

	const own = $derived(normalisePreferences(stored));
	const fromUniverse = $derived(inherited ? normalisePreferences(inherited.preferences) : null);
	const universeNotes = $derived(inherited ? normaliseNotes(inherited.notes) : null);
	const id = (key: string) => `${level}-pref-${key}`;

	function blankLabel(key: string, fallback: string): string {
		if (!fromUniverse) return fallback;
		const value = (fromUniverse as Record<string, string | undefined>)[key];
		const house = HOUSE_STYLE.find((item) => item.key === key);
		const label = house
			? house.options.find((option) => option.value === value)?.label
			: value === 'leave'
				? 'Leave alone'
				: 'Check';
		return `Use the universe's (${label ?? fallback})`;
	}
</script>

<div class="settings-group">
	<header class="settings-group-header">
		<svelte:element this={level === 'story' ? 'h3' : 'h2'} class="settings-group-title">
			Assistant preferences
		</svelte:element>
		<p class="settings-group-subtitle">
			How the Assistant reviews and drafts {level === 'story'
				? 'this story'
				: 'the stories in this universe'}. Leave a setting on "Not set" and the Assistant works it
			out from your prose.
			{#if level === 'universe'}
				A story can change any of these in its own settings.
			{:else if inherited}
				A setting on "Use the universe's" changes when you change it in the universe's settings.
			{/if}
		</p>
	</header>
	<form method="POST" action="?/saveAssistantPreferences">
		{#each HOUSE_STYLE as item (item.key)}
			<div class="field">
				<label for={id(item.key)}>{item.label}</label>
				<select id={id(item.key)} class="select" name={item.key} value={own[item.key] ?? ''}>
					<option value="">{blankLabel(item.key, 'Not set')}</option>
					{#each item.options as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
			</div>
		{/each}
		<p class="field-hint prefs-lead">
			Review, copyedit and the pattern pass look for each of these habits. Choose "Leave alone" for
			one you use on purpose.
		</p>
		{#each HABIT_CHECKS as item (item.key)}
			<div class="field">
				<label for={id(item.key)}>{item.label}</label>
				<select id={id(item.key)} class="select" name={item.key} value={own[item.key] ?? ''}>
					{#if fromUniverse}
						<option value="">{blankLabel(item.key, 'Check')}</option>
						<option value="check">Check</option>
					{:else}
						<option value="">Check</option>
					{/if}
					<option value="leave">Leave alone</option>
				</select>
			</div>
		{/each}
		<div class="field">
			<label for={id('notes')}>Your own habits</label>
			<textarea
				id={id('notes')}
				class="input"
				name="assistantNotes"
				rows="3"
				maxlength={MAX_ASSISTANT_NOTES}>{notes ?? ''}</textarea
			>
			<p class="field-hint">
				Habits only you know about, for example "I overuse the word 'just'" or "Sentence fragments
				are on purpose, leave them". Review and the pattern pass check these first. Up to {MAX_ASSISTANT_NOTES}
				characters.
				{#if universeNotes}
					Left blank, the universe's notes are used.
				{/if}
			</p>
		</div>
		<div class="settings-actions">
			<FormStatus {error} success={saved ? 'Saved.' : null} />
			<button class="btn btn-primary" type="submit">Save preferences</button>
		</div>
	</form>
</div>

<style>
	.prefs-lead {
		margin: var(--space-5) 0 var(--space-4);
	}
</style>
