<script lang="ts">
	import { CATEGORY_COLORS, storyCoverColor } from '#lib/entity-color';
	import FormStatus from '#lib/components/FormStatus.svelte';
	import { resolve } from '$app/paths';
	import { enhance } from '#lib/enhance';
	import { autosaveSubmit, autosubmitForm } from '#lib/autosave-form';
	import { inheritedChoiceLabel } from '#lib/assistant-preferences';
	import {
		normaliseLanguage,
		WRITING_LANGUAGES,
		writingLanguageLabel
	} from '#lib/writing-languages';
	import type { ActionData, PageData } from './$types';
	import { untrack } from 'svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The select overrides it so the swatch previews the choice; it resets to
	// the stored colour whenever the story's data changes.
	let coverColor = $derived(storyCoverColor(data.story));
	// What a story with no language of its own falls back to.
	let universeLanguage = $derived(normaliseLanguage(data.universe.language));
	let useInherited = $derived(inheritedChoiceLabel(data.universe.standalone));
	// The text boxes start from the stored text, read once (the page keys this
	// component by story). A value renders on the server, where defaultValue
	// leaves a text box empty and a save before the page loads would post it
	// empty; reading it once keeps a refresh from writing over newer typing.
	const initial = untrack(() => ({
		description: data.story.descriptionMd ?? '',
		styleNotes: data.story.styleNotes ?? ''
	}));
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">Details</h2>
	<p class="admin-block-sub">
		How the story is named and described, the language it is written in, and its genre and style.
	</p>
</div>
<div class="settings-group">
	<!-- Posted by id: a save made while a rename is in flight must not use the old slug. -->
	<form
		method="POST"
		action="{resolve('/stories/[id]/settings/[[section]]', { id: data.story.id })}?/update"
		use:enhance={autosaveSubmit}
		onchange={autosubmitForm}
	>
		<div class="field">
			<label for="st-title">Title</label>
			<input
				id="st-title"
				class="input"
				type="text"
				name="title"
				defaultValue={data.story.title}
				data-renames
			/>
			<span class="field-hint">
				The web address follows the title: /stories/{data.story.slug}. Renaming moves the address;
				the old one stops working.
			</span>
		</div>
		<div class="field">
			<label for="st-author">Author</label>
			<input
				id="st-author"
				class="input"
				type="text"
				name="author"
				defaultValue={data.story.author ?? ''}
			/>
		</div>
		<div class="field">
			<label for="st-brief">Brief</label>
			<input
				id="st-brief"
				class="input"
				type="text"
				name="brief"
				defaultValue={data.story.brief ?? ''}
			/>
		</div>
		<div class="field">
			<label for="st-description">Description</label>
			<textarea
				id="st-description"
				class="input"
				name="description"
				rows="4"
				value={initial.description}></textarea>
		</div>
		{#if !data.story.coverAssetId}
			<div class="field">
				<label for="st-cover-color">Cover colour</label>
				<div class="cover-color-row">
					<span class="cover-color-dot" style="background: {coverColor}"></span>
					<select id="st-cover-color" class="input" name="coverColor" bind:value={coverColor}>
						{#each CATEGORY_COLORS as choice (choice.token)}
							<option value={choice.token}>{choice.label}</option>
						{/each}
					</select>
				</div>
				<span class="field-hint">
					The colour of the cover in your library and on your public shelf. Uploading a cover image
					replaces it.
				</span>
			</div>
		{/if}
		<div class="field">
			<label for="st-language">Language</label>
			<select id="st-language" class="select" name="language" value={data.story.language ?? ''}>
				<option value="">
					{universeLanguage
						? `${useInherited}: ${writingLanguageLabel(universeLanguage)}`
						: 'Not set'}
				</option>
				{#each WRITING_LANGUAGES as language (language.tag)}
					<option value={language.tag}>{language.label}</option>
				{/each}
			</select>
			<p class="field-hint">
				The language and spelling this story is written in. The Assistant writes and checks spelling
				in it, and the editor's spell-check uses it.
				{#if universeLanguage && data.universe.standalone}
					Leave it on the standalone default unless this story differs.
				{:else if universeLanguage}
					Leave it on the universe's unless this story differs.
				{:else}
					If you leave it unset, the Assistant works it out from the text.
				{/if}
			</p>
		</div>
		<div class="field">
			<label for="st-style-notes">Genre and style</label>
			<textarea
				id="st-style-notes"
				class="input"
				name="styleNotes"
				rows="2"
				value={initial.styleNotes}></textarea>
			<p class="field-hint">
				A sentence on the genre and the style you are writing in, for example "epic fantasy serial,
				omniscient narrator, formal prose". The intended audience and a comparison title or two also
				help. The Assistant reads this and judges the prose against it. Readers never see it.
			</p>
		</div>
		<div class="settings-actions">
			<FormStatus
				error={form?.action === 'update' && form.message ? form.message : null}
				success={form?.action === 'update' && form.saved ? 'Saved.' : null}
			/>
		</div>
	</form>
</div>

<style>
	.cover-color-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.cover-color-row .input {
		width: auto;
	}
	.cover-color-dot {
		width: 14px;
		height: 14px;
		border-radius: 99px;
		flex: none;
	}
</style>
