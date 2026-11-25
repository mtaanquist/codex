<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { formatDateTime } from '#lib/format';
	import { tick } from 'svelte';
	import { enhance } from '#lib/enhance';
	import { browseHomeHref } from '#lib/browse-adult.svelte';
	import HelpLink from '#lib/components/HelpLink.svelte';
	import PenNamePrompt from '#lib/components/PenNamePrompt.svelte';
	import { reportReasonLabel } from '#lib/report-reasons';
	import TagInput from '#lib/components/TagInput.svelte';
	import { MAX_FANDOMS, MAX_GENRES, MAX_TAG_LENGTH, MAX_TAGS } from '#lib/story-tags';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The tag form's live state, reset from the page data after each save.
	let genres = $state<string[]>([]);
	let fandoms = $state<string[]>([]);
	let tags = $state<string[]>([]);
	$effect.pre(() => {
		genres = data.storyTags?.genres.map((tag) => tag.id) ?? [];
		fandoms = data.storyTags?.fandoms.filter((tag) => !tag.inherited).map((tag) => tag.name) ?? [];
		tags = data.storyTags?.tags.map((tag) => tag.name) ?? [];
	});

	// The first publish with no pen name set asks what name goes public; the
	// chosen name rides the publish form as a hidden field.
	let publishForm = $state<HTMLFormElement>();
	let penPromptOpen = $state(false);
	let chosenPenName = $state('');
	function onPublishSubmit(event: SubmitEvent) {
		if (!data.archive.penName && !chosenPenName) {
			event.preventDefault();
			penPromptOpen = true;
		}
	}
	async function confirmPenName(penName: string) {
		chosenPenName = penName;
		penPromptOpen = false;
		await tick();
		publishForm?.requestSubmit();
	}

	const FORMAT_LABELS: Record<string, string> = {
		markdown: 'Markdown (.zip)',
		epub: 'EPUB',
		pdf: 'PDF'
	};

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<div class="admin-block-head">
	<h2 class="admin-block-title">
		Publish <HelpLink topic="publishing" label="publishing" />
	</h2>
	<p class="admin-block-sub">Who can find this story, and the frozen editions readers see.</p>
</div>
{#if data.edition?.removedReason}
	<div
		class="status-banner"
		role="status"
		style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
	>
		<span class="x">
			The people who look after this site took this edition down, so readers cannot open it. Reason: {reportReasonLabel(
				data.edition.removedReason
			)}. You cannot publish it again until they restore it.
		</span>
	</div>
{:else if data.edition?.removedAt}
	<p class="field-hint" role="status">
		This edition came down when you asked to delete your account. Publish an edition to put the
		story back up.
	</p>
{/if}
<div class="settings-group">
	<form method="POST" action="?/setVisibility">
		{#if form?.action === 'publish' && form.message}
			<p class="form-error" role="alert">{form.message}</p>
		{/if}
		{#if form?.action === 'publish' && 'saved' in form && form.saved}
			<p class="field-hint" role="status" style="color:var(--status-final-ink);">Saved.</p>
		{/if}
		<div class="field">
			<label for="st-visibility">Visibility</label>
			<select id="st-visibility" class="select" name="visibility" value={data.story.visibility}>
				<option value="private">Private - not on your public pages</option>
				<option value="unlisted">Unlisted - direct link only</option>
				<option value="public">Public - listed on your shelf</option>
			</select>
		</div>
		{#if page.data.browse}
			<div class="field">
				<label class="check-row">
					<input
						type="checkbox"
						name="listedInBrowse"
						checked={data.story.listedInBrowse}
						disabled={!!data.story.browseBlockedAt}
					/>
					List in Browse
				</label>
				{#if data.story.browseBlockedAt}
					<p class="field-hint">
						The people who look after this site removed this story from Browse, so you cannot list
						it there. Reason: {reportReasonLabel(data.story.browseBlockedReason)}. Its pages are
						still up.
					</p>
				{:else}
					<p class="field-hint">
						Lets readers find a public story on the site's <a href={browseHomeHref()}>Browse</a>
						page.{#if data.archive?.hiddenFromBrowse}
							Your account is set to stay off Browse, so it will not appear there until you change
							that in your account settings.{/if}
					</p>
				{/if}
			</div>
		{/if}
		<div class="field">
			<label class="check-row">
				<input type="checkbox" name="isAdult" checked={data.story.isAdult} />
				Adult content
			</label>
			{#if data.edition}
				<p class="field-hint">Readers see a change to Adult content after you publish again.</p>
			{/if}
		</div>
		{#if data.reading}
			<p class="field-hint">
				Readers find this story at
				<a href={resolve('/@[handle]/[story=ref]', data.reading)}>
					/@{data.reading.handle}/{data.reading.story}
				</a>.
			</p>
		{/if}
		<div class="settings-actions">
			<button class="btn btn-primary" type="submit">Save visibility</button>
		</div>
	</form>
	<!-- Enhanced so a refused save keeps what the writer picked and typed. -->
	<form
		method="POST"
		action="?/saveTags"
		use:enhance={() =>
			async ({ update }) => {
				await update({ reset: false });
			}}
	>
		{#if form?.action === 'tags' && form.message}
			<p class="form-error" role="alert">{form.message}</p>
		{/if}
		{#if form?.action === 'tags' && 'saved' in form && form.saved}
			<p class="field-hint" role="status" style="color:var(--status-final-ink);">
				Saved.{#if form.skipped?.length}
					Not added, because the moderators removed them: {form.skipped.join(', ')}.{/if}
			</p>
		{/if}
		<div class="field" role="group" aria-labelledby="st-genres-label">
			<span class="field-label" id="st-genres-label">Genres</span>
			{#each data.lists.genres as genre (genre.id)}
				<label class="check-row">
					<input
						type="checkbox"
						name="genres"
						value={genre.id}
						bind:group={genres}
						disabled={genres.length >= MAX_GENRES && !genres.includes(genre.id)}
					/>
					{genre.name}
				</label>
			{:else}
				<p class="field-hint">This site has no genres to pick from yet.</p>
			{/each}
			{#if data.lists.genres.length > 0}<p class="field-hint">Pick up to {MAX_GENRES}.</p>{/if}
		</div>
		<div class="field" role="group" aria-labelledby="st-warnings-label">
			<span class="field-label" id="st-warnings-label">Content warnings</span>
			{#each data.lists.warnings as warning (warning.id)}
				<label class="check-row">
					<input
						type="checkbox"
						name="contentWarnings"
						value={warning.id}
						checked={data.storyTags?.warnings.some((tag) => tag.id === warning.id)}
					/>
					{warning.name}
				</label>
			{:else}
				<p class="field-hint">This site has no content warnings to pick from yet.</p>
			{/each}
			<p class="field-hint">
				Tick everything a reader should know about before they start.{#if data.edition}
					Readers see a change here after you publish again.{/if}
			</p>
		</div>
		<div class="field">
			<label for="st-fandoms">Fandoms</label>
			{#each fandoms as fandom (fandom)}<input type="hidden" name="fandoms" value={fandom} />{/each}
			<TagInput
				values={fandoms}
				onChange={(next) => (fandoms = next)}
				addLabel="Add fandom"
				suggestions={data.lists.fandoms}
				inputId="st-fandoms"
			/>
			<p class="field-hint">
				For a story set in an existing world. Pick up to {MAX_FANDOMS} from the site's list.{#each data.storyTags?.fandoms.filter((tag) => tag.inherited) ?? [] as fandom (fandom.id)}
					{fandom.name} comes from the universe and counts toward the {MAX_FANDOMS}.{/each}
			</p>
		</div>
		<div class="field">
			<label for="st-tags">Tags</label>
			{#each tags as tag (tag)}<input type="hidden" name="tags" value={tag} />{/each}
			<TagInput
				values={tags}
				onChange={(next) => (tags = next)}
				addLabel="Add tag"
				suggestions={data.lists.tags}
				inputId="st-tags"
				splitOnComma
			/>
			<p class="field-hint">
				Anything else that helps a reader find the story, such as "found family". Up to {MAX_TAGS},
				each up to {MAX_TAG_LENGTH} characters. Press Enter or type a comma after each one, or paste several
				separated by commas.
			</p>
		</div>
		<div class="settings-actions">
			<button class="btn btn-primary" type="submit">Save tags</button>
		</div>
	</form>
	<form method="POST" action="?/publish" bind:this={publishForm} onsubmit={onPublishSubmit}>
		<input type="hidden" name="penName" value={chosenPenName} />
		{#if form?.action === 'publish' && 'published' in form && form.published}
			<p class="field-hint" role="status" style="color:var(--status-final-ink);">
				{#if data.reading}
					Edition published. Readers see it at
					<a href={resolve('/@[handle]/[story=ref]', data.reading)}>
						/@{data.reading.handle}/{data.reading.story}
					</a>.
				{:else if data.story.visibility === 'private'}
					Edition published. Set the visibility to unlisted or public so readers can open it.
				{:else}
					Edition published, but readers cannot open it at the moment. Ask the admin of your site
					why.
				{/if}
			</p>
		{/if}
		{#if data.drafts.length > 0}
			<div class="field">
				<label for="st-edition-source">What to publish</label>
				<select
					id="st-edition-source"
					class="select"
					name="draftId"
					value={page.url.searchParams.get('draft') ?? ''}
				>
					<option value="">The working draft, as it is now</option>
					{#each data.drafts as draft (draft.id)}
						<option value={draft.id}>Saved draft: {draft.label}</option>
					{/each}
				</select>
			</div>
		{/if}
		<div class="field">
			<label for="st-edition-label">Edition label (optional)</label>
			<input
				id="st-edition-label"
				class="input"
				type="text"
				name="versionLabel"
				placeholder="Edition 2"
			/>
			<p class="field-hint">
				Publishing freezes the story as it stands now, or as a saved draft has it. Later edits stay
				private until you publish again.
			</p>
		</div>
		<div class="settings-actions">
			<button class="btn btn-primary" type="submit">Publish edition</button>
		</div>
	</form>

	{#if data.edition && data.assetsConfigured}
		<div class="sub-head">Edition downloads</div>
		{#if form?.action === 'exports' && form.message}
			<p class="form-error" role="alert">{form.message}</p>
		{/if}
		{#if form?.action === 'exports' && 'queued' in form && form.queued}
			<p class="field-hint" role="status">
				Export run queued. The files appear below in a moment; reload to see them.
			</p>
		{/if}
		{#if form?.action === 'exports' && 'saved' in form && form.saved}
			<p class="field-hint" role="status" style="color:var(--status-final-ink);">Saved.</p>
		{/if}
		{#if data.artifacts.length > 0}
			<ul class="exports">
				{#each data.artifacts as artifact (artifact.id)}
					<li>
						<a href={resolve('/artifacts/[id=uuid]', { id: artifact.id })} download>
							{FORMAT_LABELS[artifact.format] ?? artifact.format}
						</a>
						- {formatBytes(artifact.byteSize)}, generated {formatDateTime(
							artifact.createdAt,
							page.data.timeZone
						)}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="field-hint">
				The download files for this edition have not been generated yet. They are created shortly
				after publishing; if they do not appear, run the generation again.
			</p>
		{/if}
		{#if data.edition.artifactErrors.length > 0}
			<p class="field-hint" style="color:var(--danger-ink);">
				Some downloads could not be built on the last run:
				{data.edition.artifactErrors
					.map((e) => `${e.format.toUpperCase()} (${e.error})`)
					.join(', ')}. A PDF needs the headless browser set up on the server; ask an administrator,
				then generate again.
			</p>
		{/if}
		<form method="POST" action="?/regenerateExports">
			<div class="settings-actions">
				<button class="btn" type="submit">Generate again</button>
			</div>
		</form>
		<form method="POST" action="?/setDownloads">
			<div class="field">
				<label class="check-row">
					<input type="checkbox" name="downloadsPublic" checked={data.edition.downloadsPublic} />
					Let readers download this edition (EPUB and PDF) from its public page
				</label>
			</div>
			<div class="settings-actions">
				<button class="btn btn-primary" type="submit">Save</button>
			</div>
		</form>
	{/if}
</div>

<PenNamePrompt
	open={penPromptOpen}
	displayName={data.displayName}
	onConfirm={confirmPenName}
	onCancel={() => (penPromptOpen = false)}
/>

<style>
	.sub-head {
		font-size: 12.5px;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin: 18px 0 10px;
		padding-top: 14px;
		border-top: 1px solid var(--border);
	}
	.exports {
		list-style: none;
		padding: 0;
		margin: 0 0 10px;
		font-size: 13.5px;
	}
	.exports li {
		padding: 5px 0;
		color: var(--text-muted);
	}
	.exports a {
		color: var(--text);
		font-weight: 600;
	}
</style>
