<script lang="ts">
	// The "Assistant preferences" section of a story's or a universe's
	// settings: the house style, the habit checks, feedback and length, content
	// limits per content warning, and the writer's own notes. On a
	// story, a blank choice uses its universe's; on a universe, the Assistant's
	// default (infer from the text, check everything). Standalone stories share
	// a hidden universe, whose settings the writer sees as the defaults for all
	// standalone stories, so standalone words it that way.
	import { untrack } from 'svelte';
	import FormStatus from '#lib/components/FormStatus.svelte';
	import { enhance } from '#lib/enhance';
	import { autosaveSubmit, autosubmitForm, ownAction } from '#lib/autosave-form';
	import {
		ASSISTANT_CHOICES,
		CONTENT_LIMITS,
		HABIT_CHECKS,
		HOUSE_STYLE,
		inheritedChoiceLabel,
		MAX_ASSISTANT_NOTES,
		normaliseNotes,
		normalisePreferences,
		warningKey
	} from '#lib/assistant-preferences';
	import { MAX_DRAFT_WORDS, MIN_DRAFT_WORDS } from '#lib/scene-draft';

	let {
		level,
		stored,
		notes,
		inherited = null,
		standalone = false,
		warnings = [],
		saved = false,
		error = null,
		submitted = null
	}: {
		level: 'story' | 'universe';
		stored: unknown;
		notes: string | null;
		// The universe's preferences, for a story; null for a universe.
		inherited?: { preferences: unknown; notes: string | null } | null;
		// A standalone story, or the universe that holds them.
		standalone?: boolean;
		// The content warnings on the site's list, for the content limits.
		warnings?: { slug: string; name: string }[];
		saved?: boolean;
		error?: string | null;
		// What a refused save sent, shown again so nothing typed is lost.
		submitted?: Record<string, string> | null;
	} = $props();

	const values: Record<string, string> = $derived(
		submitted ??
			Object.fromEntries(
				Object.entries({ ...normalisePreferences(stored), assistantNotes: notes ?? '' }).map(
					([key, value]) => [key, String(value)]
				)
			)
	);
	// The notes box starts from the stored notes, read once (the page keys this
	// component by story or universe): a value renders on the server, unlike
	// defaultValue, and reading it once keeps a refresh from writing over newer
	// typing.
	const initialNotes = untrack(() => values.assistantNotes ?? '');
	const fromUniverse = $derived(inherited ? normalisePreferences(inherited.preferences) : null);
	const universeNotes = $derived(inherited ? normaliseNotes(inherited.notes) : null);
	const id = (key: string) => `${level}-pref-${key}`;

	const useInherited = $derived(inheritedChoiceLabel(standalone));

	// The blank choice names what it falls back to: the universe's choice, or
	// "Not set" for a house style it leaves unset. An unset habit check is
	// checked, so it says so.
	function blankLabel(key: string, fallback: string): string {
		if (!fromUniverse) return fallback;
		const value = (fromUniverse as Record<string, string | number | undefined>)[key];
		const list =
			HOUSE_STYLE.find((item) => item.key === key) ??
			ASSISTANT_CHOICES.find((item) => item.key === key);
		const label = list
			? list.options.find((option) => option.value === value)?.label
			: key.startsWith('warning:')
				? CONTENT_LIMITS.find((option) => option.value === value)?.label
				: value === 'leave'
					? 'Leave alone'
					: 'Check';
		return `${useInherited}: ${label ?? fallback}`;
	}

	// The draft length box is blank when not set; on a story it shows the
	// universe's length, when it has one, as the placeholder.
	const inheritedWords = $derived(fromUniverse?.draftWords ?? null);
</script>

{#snippet intro()}
	{#if level === 'universe' && standalone}
		The defaults for all your standalone stories: how the Assistant reviews and drafts them. Leave a
		house style setting on "Not set" and the Assistant works it out from your prose. A story can
		change any of these in its own settings.
	{:else if level === 'universe'}
		How the Assistant reviews and drafts the stories in this universe. Leave a house style setting
		on "Not set" and the Assistant works it out from your prose. A story can change any of these in
		its own settings.
	{:else if inherited && standalone}
		How the Assistant reviews and drafts this story. A setting on "{useInherited}" follows the
		settings for all your standalone stories (in your library, open Settings under Standalone
		stories, then Assistant preferences); where those are not set either, the Assistant works it out
		from your prose.
	{:else if inherited}
		How the Assistant reviews and drafts this story. A setting on "{useInherited}" follows the
		universe's settings; where the universe has not set it either, the Assistant works it out from
		your prose.
	{:else}
		How the Assistant reviews and drafts this story. Leave a house style setting on "Not set" and
		the Assistant works it out from your prose.
	{/if}
{/snippet}

<div class="admin-block-head">
	<h2 class="admin-block-title">Assistant preferences</h2>
	<p class="admin-block-sub">{@render intro()}</p>
</div>
<!-- Each page's own form style: story sections sit in a card, universe ones do not. -->
{#if level === 'universe'}
	{@render body()}
{:else}
	<div class="settings-group">{@render body()}</div>
{/if}

{#snippet body()}
	<form
		method="POST"
		action={ownAction('saveAssistantPreferences')}
		use:enhance={autosaveSubmit}
		onchange={autosubmitForm}
	>
		<fieldset class="prefs-set">
			<legend>House style</legend>
			<p class="field-hint prefs-lead">
				How your text is set out: quote marks, the serial comma, how thoughts are shown, tense and
				narration.
			</p>
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
				Reviews and copyedits look for each of these habits, and so does "Look for habits that
				repeat in the prose" in the review window. Choose "Leave alone" for one you use on purpose.
				Reviews and copyedits then skip it, and the chat in a story does not point it out or change
				it unless you ask about it.
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
		<fieldset class="prefs-set">
			<legend>Feedback and length</legend>
			<p class="field-hint prefs-lead">
				How much a review points out, whether suggested edits say why, how long summaries are, and
				how long a drafted scene is.
			</p>
			{#each ASSISTANT_CHOICES as item (item.key)}
				<div class="field">
					<label for={id(item.key)}>{item.label}</label>
					<select id={id(item.key)} class="select" name={item.key} value={values[item.key] ?? ''}>
						<option value="">{blankLabel(item.key, item.unset)}</option>
						{#each item.options as option (option.value)}
							{#if fromUniverse || option.label !== item.unset}
								<option value={option.value}>{option.label}</option>
							{/if}
						{/each}
					</select>
					{#if item.key === 'feedback'}
						<p class="field-hint">
							For a review with no checks picked. A copyedit, or a review with checks picked, always
							reports everything it finds.
						</p>
					{:else if item.key === 'summaryLength'}
						<p class="field-hint">
							Scene and chapter summaries, character arcs, and "Catch me up". Detailed ones cost
							more to write and to send with each request. Summaries already written keep their
							length until they are written again.
						</p>
					{/if}
				</div>
			{/each}
			<div class="field">
				<label for={id('draftWords')}>Length of a drafted scene, in words</label>
				<input
					id={id('draftWords')}
					class="input"
					type="number"
					name="draftWords"
					inputmode="numeric"
					min={MIN_DRAFT_WORDS}
					max={MAX_DRAFT_WORDS}
					step="1"
					placeholder={inheritedWords ? `${useInherited}: ${inheritedWords}` : ''}
					value={values.draftWords ?? ''}
				/>
				<p class="field-hint">
					The length a new draft starts with, from {MIN_DRAFT_WORDS} to {MAX_DRAFT_WORDS}. You can
					still change it for each draft. Leave it blank to use the usual length of the story's
					scenes.
				</p>
			</div>
		</fieldset>
		{#if warnings.length > 0}
			<fieldset class="prefs-set">
				<legend>Content limits</legend>
				<p class="field-hint prefs-lead">
					What you are comfortable having the Assistant draft or comment on, for each content
					warning. "Keep it off the page" asks the Assistant to imply or skip past it. "Write
					freely" tells it the subject is fine where the story calls for it. The Assistant's own
					rules still apply either way.
				</p>
				{#each warnings as warning, index (warning.slug)}
					{@const key = warningKey(warning.slug)}
					<!-- A slug may hold spaces, so the element id goes by position. -->
					<div class="field">
						<label for={id(`warning-${index}`)}>{warning.name}</label>
						<select id={id(`warning-${index}`)} class="select" name={key} value={values[key] ?? ''}>
							<option value="">{blankLabel(key, 'Not set')}</option>
							{#each CONTENT_LIMITS as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
					</div>
				{/each}
			</fieldset>
		{/if}
		<div class="field">
			<label for={id('notes')}>Your own habits</label>
			<textarea
				id={id('notes')}
				class="input"
				name="assistantNotes"
				rows="3"
				maxlength={MAX_ASSISTANT_NOTES}
				value={initialNotes}></textarea>
			<p class="field-hint">
				Habits only you know about, for example "I overuse the word 'just'" or "Sentence fragments
				are on purpose, leave them". Reviews, including "Look for habits that repeat in the prose",
				check these first, and the chat in a story keeps to them. Up to {MAX_ASSISTANT_NOTES}
				characters.
				{#if universeNotes}
					Left blank, the {standalone
						? 'notes for all your standalone stories'
						: "universe's notes"} are used.
				{/if}
			</p>
		</div>
		<div class="settings-actions">
			<FormStatus {error} success={saved ? 'Saved.' : null} />
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
