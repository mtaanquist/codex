<script lang="ts">
	import { enhance } from '#lib/enhance';
	import { browseHomeHref } from '#lib/browse-adult.svelte';
	import { autosaveSubmit, autosubmitForm, ownAction } from '#lib/autosave-form';
	import FormStatus from '#lib/components/FormStatus.svelte';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const TYPE_OPTIONS = [
		{
			value: 'personal',
			name: 'Private',
			desc: 'The front page is short: a title, the sign-in button, and a line on who can get an account.'
		},
		{
			value: 'service',
			name: 'Public service',
			desc: 'The front page introduces Codex in full, for visitors who have not heard of it.'
		}
	] as const;
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Configuration</p>
	<h1 class="admin-title">Instance</h1>
	<p class="admin-lede">What visitors see before they sign in, and how this Codex sends email.</p>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<div>
			<h2 class="admin-block-title">Type</h2>
			<p class="admin-block-sub">
				Changes only the front page that visitors see before they sign in. Who can get an account is
				set under Users &amp; access, in Sign-up.
			</p>
		</div>
	</div>

	{#if form?.scope === 'instance-type' && form.message}
		<div class="status-banner error" role="alert" style="margin-bottom:var(--space-4);">
			<span class="x">{form.message}</span>
		</div>
	{:else if form?.scope === 'instance-type' && form.saved}
		<div class="status-banner ok" role="status" style="margin-bottom:var(--space-4);">
			<span class="dot"></span><span class="v">Saved.</span>
		</div>
	{/if}

	<form method="POST" action="?/saveInstanceType">
		<div class="policy-grid">
			{#each TYPE_OPTIONS as option (option.value)}
				<label class="policy-card">
					<input
						type="radio"
						name="type"
						value={option.value}
						checked={data.instanceType === option.value}
					/>
					<span class="policy-radio"></span>
					<div>
						<div class="policy-name">{option.name}</div>
						<div class="policy-desc">{option.desc}</div>
					</div>
				</label>
			{/each}
		</div>
		<div class="settings-actions">
			<button type="submit" class="btn btn-primary">Save</button>
		</div>
	</form>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<div>
			<h2 class="admin-block-title">Browse</h2>
			<p class="admin-block-sub">
				A public page at {#if data.browse}<a href={browseHomeHref()}>/browse</a>{:else}/browse{/if} where
				readers find stories from every author on this site. Authors choose which public stories appear
				there. While it is off, the page does not exist and authors do not see the option.
			</p>
		</div>
	</div>
	<div class="admin-card">
		<form
			method="POST"
			action={ownAction('saveBrowse')}
			use:enhance={autosaveSubmit}
			onchange={autosubmitForm}
		>
			<div class="toggle-row">
				<div>
					<div class="t-title">Browse page</div>
					<div class="t-sub">Turn on to show the Browse page and the links to it.</div>
				</div>
				<label class="toggle">
					<input type="checkbox" name="enabled" aria-label="Browse page" checked={data.browse} />
					<span class="toggle-track"></span>
				</label>
			</div>
			<FormStatus
				error={null}
				success={form?.scope === 'browse' && 'saved' in form && form.saved ? 'Saved.' : null}
			/>
		</form>
	</div>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<div>
			<h2 class="admin-block-title">Email relay</h2>
			<p class="admin-block-sub">
				Used to send verification, password-reset, and notification emails.
				{#if data.smtp.source === 'environment'}
					Currently taking values from the environment; saving here overrides them.
				{:else if data.smtp.source === 'none'}
					Not configured yet; until it is, emails are written to the worker log instead of sent.
				{/if}
			</p>
		</div>
	</div>

	{#if !data.secretsAvailable}
		<div
			class="status-banner"
			style="background:color-mix(in oklab, var(--status-draft) 12%, transparent);border:1px solid color-mix(in oklab, var(--status-draft) 32%, transparent);"
		>
			<span class="x">
				Set APP_SECRET on the server to store a password here. Without it you can still seed SMTP
				from environment variables.
			</span>
		</div>
	{/if}

	<div class="admin-card">
		<form method="POST" action="?/saveSmtp">
			{#if form?.scope === 'smtp' && form.message}
				<div class="status-banner error" role="alert">
					<span class="x">{form.message}</span>
				</div>
			{:else if form?.scope === 'smtp' && form.saved}
				<div class="status-banner ok" role="status">
					<span class="dot"></span><span class="v">Saved.</span>
				</div>
			{:else if form?.scope === 'smtp' && form.tested}
				<div class="status-banner ok" role="status">
					<span class="dot"></span><span class="v">Test email sent to {form.testTo}.</span>
				</div>
			{/if}

			<div class="field-grid">
				<div class="field">
					<label for="smtp-host">Host</label>
					<input
						id="smtp-host"
						class="input"
						type="text"
						name="host"
						value={data.smtp.host}
						placeholder="smtp.example.com"
					/>
				</div>
				<div class="field">
					<label for="smtp-port">Port</label>
					<input id="smtp-port" class="input" type="number" name="port" value={data.smtp.port} />
				</div>
			</div>

			<div class="toggle-row" style="margin-bottom:var(--space-4);">
				<label class="toggle">
					<input
						type="checkbox"
						name="secure"
						aria-label="Use TLS on connect"
						checked={data.smtp.secure}
					/>
					<span class="toggle-track"></span>
				</label>
				<div style="flex:1;">
					<div class="t-title">Use TLS on connect</div>
					<div class="t-sub">
						Turn on if your relay asks for implicit TLS or SSL; leave off if it asks for STARTTLS.
						Go by the relay's instructions, not the port: 465 usually means on and 587 usually off,
						but some relays differ.
					</div>
				</div>
			</div>

			<div class="field">
				<label for="smtp-user">Username</label>
				<input
					id="smtp-user"
					class="input"
					type="text"
					name="user"
					value={data.smtp.user}
					autocomplete="off"
				/>
			</div>
			<div class="field">
				<label for="smtp-password">Password</label>
				<input
					id="smtp-password"
					class="input"
					type="password"
					name="password"
					autocomplete="off"
					placeholder={data.smtp.hasPassword ? 'Leave blank to keep the current password' : ''}
				/>
			</div>
			<div class="field">
				<label for="smtp-from">From address</label>
				<input
					id="smtp-from"
					class="input"
					type="text"
					name="from"
					value={data.smtp.from}
					placeholder="Codex <no-reply@example.com>"
				/>
			</div>
			<div class="field" style="margin-bottom:0;">
				<label for="smtp-test-to">Send the test to</label>
				<input id="smtp-test-to" class="input" type="email" name="testTo" value={data.meEmail} />
				<span class="field-hint">Only used by the test button below.</span>
			</div>

			<div class="settings-actions">
				<button type="submit" formaction="?/testEmail" class="btn btn-ghost">
					Send test email
				</button>
				<button type="submit" class="btn btn-primary">Save</button>
			</div>
		</form>
	</div>
</div>
