<script lang="ts">
	import { resolve } from '$app/paths';
	import AuthShell from '#lib/components/AuthShell.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Once the writer has answered, the server names the app's address to go
	// to. Left as a link too, for a browser that does not follow it.
	const continueTo = $derived(form && 'continueTo' in form ? form.continueTo : null);
	$effect(() => {
		if (continueTo) window.location.replace(continueTo);
	});

	// A refused Allow or Deny. The form was posted to the action's address,
	// which no longer carries the app's request, so it is shown on its own
	// and not under what the load made of that address.
	const refusal = $derived(form && 'message' in form && form.message ? form.message : null);
</script>

<!-- The name is the app's own word for itself, so it is shown as a claim, on
     a line and in a style of its own: whatever the name says, it cannot read
     as part of what Codex says around it. What Codex does know, where the
     answer goes, has a line to itself too. -->
{#snippet claim(account: string)}
	{#if data.status === 'ok'}
		<p class="auth-sub consent-claim">
			An app wants to connect to your Codex account{account}. It calls itself:
			<span class="consent-name">{data.client.clientName || data.client.host}</span>
		</p>
	{/if}
{/snippet}

{#snippet answerGoesTo()}
	{#if data.status === 'ok'}
		<p class="auth-note consent-host">
			{#if data.local}
				The app runs on this computer.
			{:else}
				It will send you back to {data.redirectHost}.
			{/if}
		</p>
	{/if}
{/snippet}

<svelte:head>
	<title>Connect an app - Codex</title>
</svelte:head>

{#if continueTo}
	<AuthShell title="Returning to the app">
		<p class="auth-note" role="status">
			You are being sent back to the app. If nothing happens, use the link below.
		</p>
		<div class="auth-links">
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the app's own address, outside this site -->
			<a href={continueTo} rel="noreferrer">Continue</a>
		</div>
	</AuthShell>
{:else if refusal}
	<AuthShell title="The app was not connected">
		<p class="form-error auth-note" role="alert">{refusal}</p>
		<div class="auth-links">
			<a href={resolve('/account/[[section]]', { section: 'apps' })}>Open Connected apps</a>
			<a href={resolve('/')}>Go to your library</a>
		</div>
	</AuthShell>
{:else if data.status === 'invalid'}
	<AuthShell title="This link does not work">
		<p class="form-error auth-note" role="alert">{data.message}</p>
		<div class="auth-links">
			<a href={resolve('/')}>Go to your library</a>
		</div>
	</AuthShell>
{:else if data.status === 'refused'}
	<AuthShell title="This request cannot be answered">
		<p class="form-error auth-note" role="alert">
			The app that sent you here asked for something Codex does not support. Nothing was shared with
			it.
		</p>
		<div class="auth-links">
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the app's own address, outside this site -->
			<a class="consent-return" href={data.returnTo} rel="noreferrer">Return to {data.host}</a>
			<a href={resolve('/')}>Go to your library</a>
		</div>
	</AuthShell>
{:else if !data.accessOn}
	<AuthShell title="Connect an app">
		{@render claim('')}
		{@render answerGoesTo()}
		<p class="auth-note">
			Access for other apps is turned off for your account. To connect this app, turn it on under
			Account, Connected apps, then go back to the app and connect again.
		</p>
		<div class="auth-links">
			<a href={resolve('/account/[[section]]', { section: 'apps' })}>Open Connected apps</a>
		</div>
	</AuthShell>
{:else}
	<AuthShell title="Connect an app">
		{@render claim(` (${data.email})`)}
		{@render answerGoesTo()}
		<p class="auth-lede">
			{#if data.connected}
				This app is already connected. Allowing it again replaces what it may do with your choice
				below.
				{#if data.endsConnectionAt}
					It is connected through <span class="consent-other">{data.endsConnectionAt}</span> now. Allowing
					this ends that connection.
				{/if}
			{/if}
			{#if !data.connected || data.local}
				Only allow this if you started it yourself, from an app you trust.
			{/if}
		</p>
		<form method="POST" action="?/allow">
			{#each data.fields as field (field.name)}
				<input type="hidden" name={field.name} value={field.value} />
			{/each}
			<fieldset class="consent-list">
				<legend class="consent-legend">Allow this app to</legend>
				{#each data.permissions as permission (permission.id)}
					<label class="choice">
						<input
							type="checkbox"
							name="permission"
							value={permission.id}
							checked={permission.checked || permission.required}
							disabled={permission.required}
							aria-describedby="consent-{permission.id}-hint"
						/>
						<span>
							{permission.label}
							<span class="choice-hint" id="consent-{permission.id}-hint">
								{permission.description}
							</span>
						</span>
					</label>
				{/each}
			</fieldset>
			<p class="auth-note">
				The app can never delete or publish your writing, and it only changes your text when you
				accept one of its suggestions. You can disconnect it at any time under Account, Connected
				apps.
			</p>
			<div class="auth-actions">
				<button class="btn btn-primary" type="submit">Allow</button>
			</div>
			<div class="auth-actions">
				<button class="btn btn-secondary" type="submit" formaction="?/deny">Do not allow</button>
			</div>
		</form>
	</AuthShell>
{/if}

<style>
	.consent-list {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.consent-host {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.consent-claim {
		margin-bottom: var(--space-3);
	}
	.consent-name {
		display: block;
		margin-top: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		font-family: var(--font-ui);
		font-weight: 600;
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.consent-other,
	.consent-return {
		overflow-wrap: anywhere;
		min-width: 0;
	}
	.consent-legend {
		padding: 0;
		margin-bottom: var(--space-2);
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-muted);
	}
</style>
