<script lang="ts">
	// The "Assistant preferences" section of a story's or a universe's
	// settings: the house style, the habit checks, feedback and length, content
	// limits per content warning, and the writer's own notes. On a
	// story, a blank choice uses its universe's; on a universe, the Assistant's
	// default (infer from the text, check everything). Standalone stories share
	// a hidden universe, whose settings the writer sees as the defaults for all
	// standalone stories, so standalone words it that way.
	import { tick, untrack } from 'svelte';
	import FormStatus from '#lib/components/FormStatus.svelte';
	import { enhance } from '#lib/enhance';
	import { autosaveSubmit, autosubmitForm, ownAction } from '#lib/autosave-form';
	import type { SubmitFunction } from '$app/forms';
	import {
		ASSISTANT_CHOICES,
		CHANGED_LIMITS_FIELD,
		CONTENT_LIMITS,
		foldedLimit,
		foldedPreferences,
		HABIT_CHECKS,
		HOUSE_STYLE,
		inheritedChoiceLabel,
		inheritedLabel,
		limitNote,
		MAX_ASSISTANT_NOTES,
		normaliseNotes,
		normalisePreferences,
		shownPreferences,
		USE_UNIVERSE_NOTES,
		WARNING_LIST_FIELD,
		warningKey,
		warningListFingerprint
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
		notice = null,
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
		// The content warnings on the site's list, for the content limits, each
		// with the slugs of the warnings merged into it.
		warnings?: { slug: string; name: string; merged: string[] }[];
		saved?: boolean;
		// Shown in place of "Saved." when a save left some settings alone.
		notice?: string | null;
		error?: string | null;
		// What a refused save sent, shown again so nothing typed is lost.
		submitted?: Record<string, string> | null;
	} = $props();

	// A refused save shows what it sent over the stored values: it carries no
	// value for a warning the form did not show. Each warning shows its limit
	// folded with the ones merged into it, on a story read over the
	// universe's, which is what applies (shownLimit; the save compares against
	// the same, see limitChanges).
	const own = $derived(normalisePreferences(stored));
	const universeOwn = $derived(inherited ? normalisePreferences(inherited.preferences) : null);
	const values: Record<string, string> = $derived({
		...Object.fromEntries(
			Object.entries({
				...shownPreferences(own, universeOwn, warnings),
				assistantNotes: notes ?? ''
			}).map(([key, value]) => [key, String(value)])
		),
		...submitted
	});
	// The notes box starts from the stored notes, read once (the page keys this
	// component by story or universe): a value renders on the server, unlike
	// defaultValue, and reading it once keeps a refresh from writing over newer
	// typing.
	const initialNotes = untrack(() => values.assistantNotes ?? '');
	const fromUniverse = $derived(universeOwn ? foldedPreferences(universeOwn, warnings) : null);
	const universeNotes = $derived(inherited ? normaliseNotes(inherited.notes) : null);
	const id = (key: string) => `${level}-pref-${key}`;

	const useInherited = $derived(inheritedChoiceLabel(standalone));
	const inheritedNotesShort = $derived(
		standalone ? 'notes for all your standalone stories' : "universe's notes"
	);
	const inheritedNotesName = $derived(
		standalone ? 'Notes for all your standalone stories' : "The universe's notes"
	);

	const blankLabel = (key: string, fallback: string) =>
		inheritedLabel(key, fromUniverse, fallback, standalone);

	// A note under a warning whose select does not tell the whole story.
	function limitHint(warning: { slug: string; merged: string[] }): string | null {
		const note = limitNote(own, universeOwn, warning);
		if (note === 'universe') {
			return standalone
				? 'Kept off the page, because the settings for all your standalone stories keep this warning, or one merged into it, off the page. To write freely in this story, choose "Write freely".'
				: 'Kept off the page, because the universe\'s settings keep this warning, or one merged into it, off the page. To write freely in this story, choose "Write freely".';
		}
		if (note === 'merged') {
			return foldedLimit(own, warning) === 'avoid'
				? 'Kept off the page because of a warning that was merged into this one. Pick another choice to change it.'
				: 'Set on a warning that was merged into this one. Pick another choice to change it.';
		}
		return null;
	}

	// The warnings whose limit the writer changed on this page and has not yet
	// saved. A save posts only those limits, with the warning list the page was
	// built from, so a save of another field leaves every limit as it is, and a
	// limit set against a list that has since changed is not stored (see
	// readPreferencesForm and savePreferences). Each entry counts its changes,
	// so a save only forgets a change made before it started.
	// Not shown anywhere, so not reactive.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const changedLimits = new Map<string, number>();
	const markChanged = (slug: string) => changedLimits.set(slug, (changedLimits.get(slug) ?? 0) + 1);
	// Saves run one at a time, so two quick changes cannot land out of order and
	// store the earlier one. A change made while a save is in flight is sent
	// once that save lands, with whatever the form then holds; the save it
	// follows skips its refresh, which would write that save's values back
	// over the newer ones in the form.
	let saving = false;
	let queued = false;
	// The writer's last pick in each select, numbered in order. A change made
	// while a save's refresh is landing is sent at once, and the refresh can
	// then put the older stored value on show until that save lands; the pick
	// is put back instead.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const picks = new Map<string, { value: string; at: number }>();
	let pickCount = 0;
	function onFormChange(event: Event & { currentTarget: HTMLFormElement }) {
		const control = event.target;
		if (control instanceof HTMLSelectElement && control.name) {
			picks.set(control.name, { value: control.value, at: ++pickCount });
		}
		autosubmitForm(event);
	}
	// A refresh that changes the warning list, other than one this form's own
	// save made (whose handler deals with its limits), drops the limit changes
	// not yet saved: they were picked against the old list, and a later save
	// would otherwise post whatever the rebuilt select shows as the change.
	// The selects go back to what is stored, and a note says so. A change the
	// save in flight carries is left to that save, which knows whether it
	// landed (listMoved tells it the list changed meanwhile).
	let refreshing = 0;
	let inFlight: Map<string, number> | null = null;
	let listMoved = false;
	let limitsDropped = $state(false);
	let formNode = $state<HTMLFormElement>();
	let builtFrom = untrack(() => warningListFingerprint(warnings));
	$effect(() => {
		const list = warningListFingerprint(warnings);
		if (list === builtFrom) return;
		builtFrom = list;
		if (refreshing > 0) return;
		if (inFlight) listMoved = true;
		const dropped = [...changedLimits]
			.filter(([slug, count]) => inFlight?.get(slug) !== count)
			.map(([slug]) => slug);
		if (dropped.length > 0) untrack(() => dropLimitChanges(dropped));
	});
	function dropLimitChanges(dropped: string[]) {
		for (const slug of dropped) changedLimits.delete(slug);
		limitsDropped = true;
		const shown = shownPreferences(own, universeOwn, warnings) as Record<string, unknown>;
		tick().then(() => {
			for (const slug of dropped) {
				const key = warningKey(slug);
				picks.delete(key);
				const select = formNode?.elements.namedItem(key);
				if (select instanceof HTMLSelectElement) select.value = String(shown[key] ?? '');
			}
		});
	}
	const submitPreferences: SubmitFunction = async (input) => {
		if (saving) {
			queued = true;
			input.cancel();
			return;
		}
		saving = true;
		limitsDropped = false;
		const sent = new Map(changedLimits);
		inFlight = sent;
		for (const slug of sent.keys()) input.formData.append(CHANGED_LIMITS_FIELD, slug);
		input.formData.set(WARNING_LIST_FIELD, warningListFingerprint(warnings));
		const after = await autosaveSubmit(input);
		return async (opts) => {
			const { result, formElement } = opts;
			const outdated = result.type === 'success' && Boolean(result.data?.notice);
			// A limit the save left alone (the warning list changed) is still
			// the writer's unsaved change, so a save queued behind this one
			// sends it again and gets the same notice.
			if (result.type === 'success' && !outdated) {
				for (const [slug, count] of sent) {
					if (changedLimits.get(slug) === count) changedLimits.delete(slug);
				}
			}
			saving = false;
			inFlight = null;
			// A save that did not land while the list changed under it leaves
			// changes picked against the old list: dropped, as a refresh would.
			const stale =
				listMoved && result.type !== 'success'
					? [...sent]
							.filter(([slug, count]) => changedLimits.get(slug) === count)
							.map(([slug]) => slug)
					: [];
			if (stale.length > 0) dropLimitChanges(stale);
			listMoved = false;
			if (queued) {
				queued = false;
				// Started before this save's own bookkeeping, so leaving the page
				// still waits for it.
				formElement.requestSubmit();
				// The queued save starts by clearing the note.
				if (stale.length > 0) limitsDropped = true;
				if (after) await after({ ...opts, update: async () => {} });
				return;
			}
			const refreshedAt = pickCount;
			refreshing += 1;
			try {
				if (after) await after(opts);
				else await opts.update();
				await tick();
			} finally {
				refreshing -= 1;
			}
			for (const [name, pick] of picks) {
				const select = formElement.elements.namedItem(name);
				if (pick.at > refreshedAt && select instanceof HTMLSelectElement) {
					select.value = pick.value;
				}
			}
			// A save that left the limits alone shows what is stored again. A
			// select only takes its value when the stored one changes, so the
			// writer's pick would otherwise stay on show.
			if (outdated) {
				for (const [slug, count] of sent) {
					if (changedLimits.get(slug) !== count) continue;
					changedLimits.delete(slug);
					const key = warningKey(slug);
					// So the put-back of a slower refresh does not bring it back.
					picks.delete(key);
					const select = formElement.elements.namedItem(key);
					if (select instanceof HTMLSelectElement) select.value = values[key] ?? '';
				}
			}
		};
	};

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
		bind:this={formNode}
		use:enhance={submitPreferences}
		onchange={onFormChange}
		novalidate
	>
		<!-- novalidate: the browser's own check on the draft length would block
		     every autosave until it was fixed, and never show the server's message. -->
		<fieldset class="field-set prefs-set">
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
		<fieldset class="field-set prefs-set">
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
		<fieldset class="field-set prefs-set">
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
							<!-- On a universe the blank choice already means the default, so the
							     same option is left out, unless it is what is stored. -->
							{#if fromUniverse || option.label !== item.unset || values[item.key] === option.value}
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
							Scene and chapter summaries, character arcs, and "Catch me up".{level === 'story'
								? " Character arcs follow the universe's setting, since an arc spans its stories."
								: ''} Detailed ones cost more. Summaries already written keep their length until they
							are written again.
						</p>
					{/if}
				</div>
			{/each}
			<div class="field">
				<label for={id('draftWords')}>Length of a drafted scene, in words</label>
				<input
					id={id('draftWords')}
					class="input"
					type="text"
					name="draftWords"
					inputmode="numeric"
					placeholder={inheritedWords ? `${useInherited}: ${inheritedWords}` : ''}
					value={values.draftWords ?? ''}
				/>
				<p class="field-hint">
					The length a new draft starts with, from {MIN_DRAFT_WORDS} to {MAX_DRAFT_WORDS}. You can
					still change it for each draft.
					{#if inherited}
						Leave it blank to use {standalone
							? 'the length for all your standalone stories'
							: "the universe's length"}{inheritedWords
							? ` (${inheritedWords} words)`
							: ", or, where that is blank too, the usual length of the story's scenes"}.
					{:else}
						Leave it blank to use the usual length of each story's scenes.
					{/if}
				</p>
			</div>
		</fieldset>
		{#if warnings.length > 0}
			<fieldset class="field-set prefs-set">
				<legend>Content limits</legend>
				<p class="field-hint prefs-lead">
					What you are comfortable having the Assistant draft or comment on, for each content
					warning. "Keep it off the page" asks the Assistant to imply or skip past it. "Write
					freely" tells it the subject is fine where the story calls for it. The Assistant's own
					rules still apply either way. A limit you set on a warning that was later merged into
					another still applies to the one it was merged into. Where the two differ, "Keep it off
					the page" wins, and the choice shown here already counts both. Pick a different choice to
					replace both.
				</p>
				<!-- Built again when the list changes, so each select shows what is stored. -->
				{#key warningListFingerprint(warnings)}
					{#each warnings as warning, index (warning.slug)}
						{@const key = warningKey(warning.slug)}
						{@const hint = limitHint(warning)}
						<!-- A slug may hold characters an element id cannot, so the id goes by position. -->
						<div class="field">
							<label for={id(`warning-${index}`)}>{warning.name}</label>
							<!-- Marked before the form's own change handler saves it. -->
							<select
								id={id(`warning-${index}`)}
								class="select"
								name={key}
								value={values[key] ?? ''}
								onchange={() => markChanged(warning.slug)}
							>
								<option value="">{blankLabel(key, 'Not set')}</option>
								{#each CONTENT_LIMITS as option (option.value)}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
							{#if hint}
								<p class="field-hint">{hint}</p>
							{/if}
						</div>
					{/each}
				{/key}
				{#if limitsDropped}
					<p class="field-hint" role="status">
						The list of content warnings has changed, so the content limits you changed were not
						saved. Set them again.
					</p>
				{/if}
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
			</p>
		</div>
		{#if universeNotes}
			<div class="field">
				<label for={id('universe-notes')}>{inheritedNotesName}</label>
				<textarea id={id('universe-notes')} class="input" rows="3" readonly value={universeNotes}
				></textarea>
				<p class="field-hint">
					{standalone
						? 'Set in the settings for all your standalone stories.'
						: "Set in the universe's settings."} You can change them there.
				</p>
			</div>
			<div class="field">
				<label for={id(USE_UNIVERSE_NOTES)}>When your own habits are blank</label>
				<select
					id={id(USE_UNIVERSE_NOTES)}
					class="select"
					name={USE_UNIVERSE_NOTES}
					value={values[USE_UNIVERSE_NOTES] ?? ''}
				>
					<option value="">Use the {inheritedNotesShort}</option>
					<option value="no">Use no notes for this story</option>
				</select>
				<p class="field-hint">
					Your own habits above always come first. This only matters while that box is blank.
				</p>
			</div>
		{/if}
		<div class="settings-actions">
			<FormStatus {error} success={saved ? (notice ?? 'Saved.') : null} />
		</div>
	</form>
{/snippet}

<style>
	.prefs-set {
		margin-bottom: var(--space-5);
	}
	.prefs-lead {
		margin: 0 0 var(--space-4);
	}
</style>
