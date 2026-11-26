<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { tick } from 'svelte';
	import { enhance } from '#lib/enhance';
	import { autosaveSubmit, autosubmitForm, ownAction } from '#lib/autosave-form';
	import FormStatus from '#lib/components/FormStatus.svelte';
	import { shrinkImagesOnSubmit } from '#lib/image-shrink';
	import { formatBytes } from '#lib/format';
	import PenNamePrompt from '#lib/components/PenNamePrompt.svelte';
	import { WRITING_LANGUAGES } from '#lib/writing-languages';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let avatarForm = $state<HTMLFormElement | null>(null);
	let avatarShrinking = $state(false);
	let profileForm = $state<HTMLFormElement | null>(null);

	// Claiming the handle is the first step into public, so with no pen name
	// set it asks what name goes on the page; the choice rides the claim form
	// as a hidden field.
	let handleForm = $state<HTMLFormElement | null>(null);
	let penPromptOpen = $state(false);
	let chosenPenName = $state('');
	function onClaimSubmit(event: SubmitEvent) {
		if (!data.profile.penName && !chosenPenName) {
			event.preventDefault();
			penPromptOpen = true;
		}
	}
	async function confirmPenName(penName: string) {
		chosenPenName = penName;
		penPromptOpen = false;
		await tick();
		handleForm?.requestSubmit();
	}

	// The links editor works on a local copy seeded once from the loaded
	// profile; the form posts it as JSON. Start with one empty row so there is
	// always something to fill in. Removing a row is a button click, not a
	// field change, so it saves itself once the hidden JSON catches up.
	// svelte-ignore state_referenced_locally
	let links = $state(
		data.profile.links?.length
			? data.profile.links.map((link) => ({ ...link }))
			: [{ label: '', url: '' }]
	);
	function addLink() {
		links = [...links, { label: '', url: '' }];
	}
	async function removeLink(index: number) {
		links = links.filter((_, i) => i !== index);
		if (links.length === 0) links = [{ label: '', url: '' }];
		await tick();
		profileForm?.requestSubmit();
	}
	const linksJson = $derived(JSON.stringify(links.filter((link) => link.url.trim())));

	function initials(name: string): string {
		const parts = name.trim().split(/\s+/).filter(Boolean);
		const first = parts[0]?.[0] ?? '';
		const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
		return (first + last).toUpperCase() || '?';
	}

	const handleUrl = $derived(data.profile.handle ? `${data.origin}/@${data.profile.handle}` : '');
	const handlePath = $derived(
		data.profile.handle ? resolve('/@[handle]', { handle: data.profile.handle }) : null
	);
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Account</p>
	<h1 class="admin-title">Profile</h1>
	<p class="admin-lede">Your identity in the app, and the public page other people can see.</p>
</div>

<div class="admin-block">
	<div class="settings-group">
		<div class="avatar-edit">
			<div class="avatar-lg">
				{#if data.profile.avatarAssetId}
					<img src="/assets/{data.profile.avatarAssetId}" alt="" />
				{:else}
					{initials(data.displayName)}
				{/if}
			</div>
			<div class="avatar-edit-actions">
				{#if data.assetsConfigured}
					<div class="row">
						<form
							method="POST"
							action="?/uploadAvatar"
							enctype="multipart/form-data"
							bind:this={avatarForm}
							use:shrinkImagesOnSubmit={{
								maxBytes: data.maxImageBytes,
								onBusy: (busy) => (avatarShrinking = busy)
							}}
						>
							<label class="btn btn-secondary btn-sm" aria-busy={avatarShrinking}>
								{avatarShrinking ? 'Uploading...' : 'Upload photo'}
								<input
									type="file"
									name="file"
									accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
									hidden
									onchange={() => avatarForm?.requestSubmit()}
								/>
							</label>
						</form>
						{#if data.profile.avatarAssetId}
							<form method="POST" action="?/removeAvatar">
								<button type="submit" class="btn btn-ghost btn-sm">Remove</button>
							</form>
						{/if}
					</div>
					<p class="avatar-edit-hint">
						PNG, JPEG, WebP, GIF or AVIF, up to {formatBytes(data.maxImageBytes)}. A square image
						works best.
					</p>
					<FormStatus error={form?.scope === 'avatar' && form.message ? form.message : null} />
				{/if}
			</div>
		</div>

		<form
			method="POST"
			action={ownAction('updateName')}
			use:enhance={autosaveSubmit}
			onchange={autosubmitForm}
		>
			<div class="field">
				<label for="display-name">Display name</label>
				<input
					id="display-name"
					class="input short"
					type="text"
					name="displayName"
					value={data.displayName}
					required
					autocomplete="name"
				/>
				<p class="field-hint">Shown in your avatar initials and on any notes you write.</p>
			</div>
			<div class="field">
				<label for="pen-name">Pen name <span class="lbl-opt">optional</span></label>
				<input
					id="pen-name"
					class="input short"
					type="text"
					name="penName"
					value={data.profile.penName ?? ''}
					placeholder="A name to publish under"
				/>
				<p class="field-hint">Used as the author name on stories and your public page when set.</p>
			</div>
			<div class="field">
				<label for="native-language">Native language <span class="lbl-opt">optional</span></label>
				<select
					id="native-language"
					class="select"
					name="nativeLanguage"
					value={data.profile.nativeLanguage ?? ''}
				>
					<option value="">Not set</option>
					{#each WRITING_LANGUAGES as language (language.tag)}
						<option value={language.tag}>{language.label}</option>
					{/each}
				</select>
				<p class="field-hint">
					The language you grew up speaking. When a story's language is set to another one, a review
					that checks "Spelling and grammar" or "Prose and style", or that has "Look for habits that
					repeat in the prose" ticked, also looks for habits carried over from your native language,
					such as idioms translated word for word or false friends.
				</p>
			</div>
			<div class="settings-actions">
				<FormStatus
					error={form?.scope === 'name' && form.message ? form.message : null}
					success={form?.scope === 'name' && form.saved ? 'Saved.' : null}
				/>
			</div>
		</form>
	</div>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">Public page</h2>
		<p class="admin-block-sub">
			A simple page at your handle - a short bio readers can find. Private by default.
		</p>
	</div>

	{#if !data.profile.publicArchiveEnabled}
		<div class="admin-card">
			{#if data.isAdmin}
				<form method="POST" action="?/enablePublishing">
					<p class="admin-block-sub" style="margin:0 0 10px;">
						Turn on publishing for your account, then claim a handle to show a public page.
					</p>
					<button type="submit" class="btn btn-primary">Enable publishing</button>
				</form>
			{:else}
				<p class="admin-block-sub" style="margin:0;">
					Ask an admin to enable publishing for your account before you can claim a handle and show
					a public page.
				</p>
			{/if}
		</div>
	{:else if !data.profile.handle}
		<div class="admin-card">
			<form method="POST" action="?/claimHandle" bind:this={handleForm} onsubmit={onClaimSubmit}>
				<input type="hidden" name="penName" value={chosenPenName} />
				<div class="field" style="margin-bottom:0;">
					<label for="handle">Claim your handle</label>
					<input
						id="handle"
						class="input short"
						type="text"
						name="handle"
						placeholder="your-name"
						pattern="[a-z0-9][a-z0-9-]+"
						required
					/>
					<p class="field-hint">
						3-30 characters: letters, numbers, and dashes. This is permanent and cannot be changed
						once claimed.
					</p>
				</div>
				<div class="settings-actions">
					<FormStatus error={form?.scope === 'handle' && form.message ? form.message : null} />
					<button type="submit" class="btn btn-primary">Claim handle</button>
				</div>
			</form>
		</div>
	{:else}
		<div class="admin-card">
			<form
				method="POST"
				action={ownAction('saveProfile')}
				bind:this={profileForm}
				use:enhance={autosaveSubmit}
				onchange={autosubmitForm}
			>
				<div class="toggle-row vis-head" style="margin-bottom:var(--space-4);">
					<div>
						<div class="t-title">Visibility</div>
						<div class="t-sub">
							When on, your handle page is listed publicly with the bio below.
						</div>
					</div>
					<label class="toggle">
						<input
							type="checkbox"
							name="profilePublic"
							aria-label="List my page publicly"
							checked={data.profile.profilePublic}
						/>
						<span class="toggle-track"></span>
					</label>
				</div>

				<div class="field">
					<label for="page-address">Page address</label>
					<div class="copy-field">
						<input id="page-address" type="text" value={handleUrl} readonly />
					</div>
					<p class="field-hint">
						Where your page lives.
						<a href={handlePath}>Open your page</a> - until visibility is on, it shows a preview only
						you can see. Publish stories from their settings page.
					</p>
				</div>

				<div class="field">
					<label for="bio">Bio</label>
					<textarea
						id="bio"
						class="textarea"
						name="bioMd"
						rows="3"
						placeholder="A short paragraph about you. Basic Markdown is fine."
						>{data.profile.bioMd ?? ''}</textarea
					>
				</div>

				<div class="field">
					<!-- svelte-ignore a11y_label_has_associated_control -->
					<label>Links</label>
					<input type="hidden" name="links" value={linksJson} />
					<div class="link-list">
						{#each links as link, i (i)}
							<div class="link-row">
								<input
									type="text"
									class="input"
									style="max-width:9rem;"
									placeholder="Label"
									aria-label="Link label"
									bind:value={link.label}
								/>
								<input
									type="text"
									class="input"
									placeholder="https://example.com"
									aria-label="Link address"
									bind:value={link.url}
								/>
								<button
									type="button"
									class="link-del"
									aria-label="Remove link"
									onclick={() => removeLink(i)}
								>
									<svg
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<line x1="5" y1="12" x2="19" y2="12" />
									</svg>
								</button>
							</div>
						{/each}
					</div>
					<button type="button" class="btn btn-ghost btn-sm link-add" onclick={addLink}>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
						</svg>Add link
					</button>
					<p class="field-hint">
						Your website, social profiles, or anywhere else readers can find you.
					</p>
				</div>

				<div class="field" style="margin-bottom:0;">
					<!-- svelte-ignore a11y_label_has_associated_control -->
					<label>Commissions</label>
					<div class="toggle-row" style="margin-bottom:var(--space-2);">
						<label class="toggle">
							<input
								type="checkbox"
								name="commissionsOpen"
								aria-label="Open for commissions"
								checked={data.profile.commissionsOpen}
							/>
							<span class="toggle-track"></span>
						</label>
						<div style="flex:1;">
							<div class="t-title">Open for commissions</div>
							<div class="t-sub">Shows an "open" note on your page.</div>
						</div>
					</div>
					<input
						type="text"
						class="input"
						name="commissionsMd"
						value={data.profile.commissionsMd ?? ''}
						placeholder="A line about what you take on"
					/>
				</div>

				<div class="settings-actions">
					<FormStatus
						error={form?.scope === 'profile' && form.message ? form.message : null}
						success={form?.scope === 'profile' && form.saved ? 'Saved.' : null}
					/>
				</div>
			</form>
		</div>
		{#if page.data.browse}
			<div class="admin-card" style="margin-top:var(--space-4);">
				<form
					method="POST"
					action={ownAction('saveBrowseOptOut')}
					use:enhance={autosaveSubmit}
					onchange={autosubmitForm}
				>
					<div class="toggle-row">
						<div>
							<div class="t-title">Stay off Browse</div>
							<div class="t-sub">
								When on, none of your stories and not your name show on the site's Browse page,
								whatever each story's own setting says. Your page and stories stay reachable as
								before.
							</div>
						</div>
						<label class="toggle">
							<input
								type="checkbox"
								name="hiddenFromBrowse"
								aria-label="Stay off Browse"
								checked={data.profile.hiddenFromBrowse}
							/>
							<span class="toggle-track"></span>
						</label>
					</div>
					<!-- Without JavaScript the toggle cannot save itself. -->
					<noscript>
						<div class="settings-actions">
							<button type="submit" class="btn btn-secondary btn-sm">Save</button>
						</div>
					</noscript>
					<FormStatus
						error={form?.scope === 'browse' && form.message ? form.message : null}
						success={form?.scope === 'browse' && form.saved ? 'Saved.' : null}
					/>
				</form>
			</div>
		{/if}
	{/if}
</div>

<PenNamePrompt
	open={penPromptOpen}
	displayName={data.displayName}
	onConfirm={confirmPenName}
	onCancel={() => (penPromptOpen = false)}
/>
