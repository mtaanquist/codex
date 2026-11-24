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
		error = null,
		submitted = null
	}: {
		level: 'story' | 'universe';
		stored: unknown;
		notes: string | null;
		// The universe's preferences, for a story; null for a universe.
		inherited?: { preferences: unknown; notes: string | null } | null;
		saved?: boolean;
		error?: string | null;
		// What a refused save sent, shown again so nothing typed is lost.
		submitted?: Record<string, string> | null;
	} = $props();

	const values: Record<string, string> = $derived(
		submitted ?? { ...normalisePreferences(stored), assistantNotes: notes ?? '' }
	);
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

{#snippet intro()}
	{#if level === 'universe'}
		How the Assistant reviews and drafts the stories in this universe. Leave a house style setting
		on "Not set" and the Assistant works it out from your prose. A story can change any of these in
		its own settings.
	{:else}
		How the Assistant reviews and drafts this story. A setting on "Use the universe's" follows the
		universe's settings; where the universe has not set it either, the Assistant works it out from
		your prose.
	{/if}
{/snippet}

{#if level === 'universe'}
	<div class="admin-block-head">
		<h2 class="admin-block-title">Assistant preferences</h2>
		<p class="admin-block-sub">{@render intro()}</p>
	</div>
	{@render body()}
{:else}
	<div class="settings-group">
		<header class="settings-group-header">
			<h3 class="settings-group-title">Assistant preferences</h3>
			<p class="settings-group-subtitle">{@render intro()}</p>
		</header>
		{@render body()}
	</div>
{/if}

{#snippet body()}
	<form method="POST" action="?/saveAssistantPreferences">
		<fieldset class="prefs-set">
			<legend>House style</legend>
			{#each HOUSE_STYLE as item (item.key)}
				<div class="field">
					<label for={id(item.key)}>{item.label}</label>
					<select id={id(item.key)} class="select" name={item.key} value={values[item.key] ?? ''}>
						<option value="">{blankLabel(item.key, 'Not set')}</option>
						{#each item.options as option (option.value)}
							<option value={option.value}>{option.label}</option>
						{/each}
					</select>
				</div>
			{/each}
		</fieldset>
		<fieldset class="prefs-set">
			<legend>Habits to check</legend>
			<p class="field-hint prefs-lead">
				Review, copyedit and the pattern pass look for each of these habits. Choose "Leave alone"
				for one you use on purpose.
			</p>
			{#each HABIT_CHECKS as item (item.key)}
				<div class="field">
					<label for={id(item.key)}>{item.label}</label>
					<select id={id(item.key)} class="select" name={item.key} value={values[item.key] ?? ''}>
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
		</fieldset>
		<div class="field">
			<label for={id('notes')}>Your own habits</label>
			<textarea
				id={id('notes')}
				class="input"
				name="assistantNotes"
				rows="3"
				maxlength={MAX_ASSISTANT_NOTES}>{values.assistantNotes ?? ''}</textarea
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
{/snippet}

<style>
	/* The two groups of selects, headed like the option groups of the review
	   modal: a small uppercase legend over the rows. */
	.prefs-set {
		border: 0;
		margin: 0 0 var(--space-5);
		padding: 0;
		min-width: 0;
	}
	.prefs-set legend {
		padding: 0;
		margin-bottom: var(--space-3);
		font-size: var(--text-micro);
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.prefs-lead {
		margin: 0 0 var(--space-4);
	}
</style>
