<script lang="ts">
	import { page } from '$app/state';
	import type { PageData, ActionData } from './$types';
	import { formatBytes, formatDate, formatNumber } from '#lib/format';
	import { NO_LIMITS } from '#lib/quota';
	import S3Fields from './S3Fields.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const defaultPlan = $derived(data.plans.find((plan) => plan.isDefault));
	const planOf = (planId: string | null) =>
		planId ? data.plans.find((plan) => plan.id === planId) : defaultPlan;

	function usageText(used: number, limit: number | null, format: (n: number) => string) {
		return limit === null ? format(used) : `${format(used)} of ${format(limit)}`;
	}
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Data</p>
	<h1 class="admin-title">Usage &amp; storage</h1>
	<p class="admin-lede">
		Where uploaded images and stored export files are kept.
		{#if data.assetStorage.source === 'environment'}
			Currently taking values from the environment; saving here overrides them.
		{:else if data.assetStorage.source === 'none'}
			Not configured yet; until a bucket is set below, image uploads are off.
		{/if}
	</p>
</div>

{#if form?.scope === 'storage' && form.message}
	<div
		class="status-banner"
		style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
	>
		<span class="x">{form.message}</span>
	</div>
{:else if form?.scope === 'storage' && form.saved}
	<div class="status-banner ok">
		<span class="dot"></span><span class="v">Saved.</span>
	</div>
{:else if form?.scope === 'storage' && form.tested}
	<div class="status-banner ok">
		<span class="dot"></span><span class="v">The bucket is reachable and writable.</span>
	</div>
{:else if form?.scope === 'storage' && form.migrating}
	<div class="status-banner ok">
		<span class="dot"></span><span class="v"
			>Copy started. The worker copies every stored file; check back here for the result.</span
		>
	</div>
{/if}

{#if data.assetMigrationPending}
	<div
		class="status-banner"
		style="background:color-mix(in oklab, var(--status-draft) 12%, transparent);border:1px solid color-mix(in oklab, var(--status-draft) 32%, transparent);"
	>
		<span class="x">
			Files uploaded before the storage change are still in the old location. Copy them to the new
			storage, or dismiss this if you moved them yourself.
		</span>
		<span class="when" style="display:flex;gap:8px;">
			<form method="POST" action="?/migrateAssets">
				<button type="submit" class="btn btn-primary btn-sm">Copy files</button>
			</form>
			<form method="POST" action="?/dismissMigration">
				<button type="submit" class="btn btn-ghost btn-sm">Dismiss</button>
			</form>
		</span>
	</div>
{/if}

{#if data.assetMigration}
	<p class="admin-block-sub">
		Last copy finished {formatDate(data.assetMigration.finishedAt, page.data.timeZone)}: {data
			.assetMigration.copied} copied,
		{data.assetMigration.failed} failed{data.assetMigration.failed > 0
			? '. Failures are listed in the worker log; run the copy again to retry.'
			: '.'}
	</p>
{/if}

{#if !data.secretsAvailable}
	<div
		class="status-banner"
		style="background:color-mix(in oklab, var(--status-draft) 12%, transparent);border:1px solid color-mix(in oklab, var(--status-draft) 32%, transparent);"
	>
		<span class="x">
			Set APP_SECRET on the server to store a secret key here. Without it you can still seed asset
			storage from environment variables.
		</span>
	</div>
{/if}

<div class="admin-block">
	<div class="admin-block-head">
		<div>
			<h2 class="admin-block-title">Asset storage</h2>
			<p class="admin-block-sub">
				Any S3-compatible bucket works: S3, Backblaze B2, RustFS, R2. Use a different bucket than
				the one holding backups, so a database restore keeps every image link valid.
			</p>
		</div>
	</div>
	<div class="admin-card">
		<form method="POST" action="?/saveAssets">
			<S3Fields idPrefix="asset" view={data.assetStorage} />
			<div class="settings-actions">
				<button type="submit" formaction="?/testAssets" class="btn btn-ghost">
					Test connection
				</button>
				<button type="submit" class="btn btn-primary">Save</button>
			</div>
		</form>
	</div>
</div>

<div class="admin-block">
	<div class="admin-block-head">
		<div>
			<h2 class="admin-block-title">
				Accounts <span class="n">{data.usage.length}</span>
			</h2>
			<p class="admin-block-sub">
				What each account uses against its plan. Universes and stories in the trash do not count;
				their images count until the trash is emptied. Set limits under Plans.
			</p>
		</div>
	</div>

	{#if form?.scope === 'usage' && form.message}
		<div
			class="status-banner"
			style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
		>
			<span class="x">{form.message}</span>
		</div>
	{:else if form?.scope === 'usage' && form.recounted}
		<div class="status-banner ok">
			<span class="dot"></span><span class="v">Image storage recounted from the stored files.</span>
		</div>
	{/if}

	<div class="admin-card usage-card">
		<table class="admin-table usage-table">
			<thead>
				<tr>
					<th>Account</th>
					<th>Plan</th>
					<th class="num">Universes</th>
					<th class="num">Stories</th>
					<th class="num">Images</th>
				</tr>
			</thead>
			<tbody>
				{#each data.usage as account (account.id)}
					{@const limits = planOf(account.planId)?.limits ?? NO_LIMITS}
					<tr>
						<td>
							<div class="cell-name">{account.displayName}</div>
							<div class="cell-mail">{account.email}</div>
						</td>
						<td data-label="Plan">
							<form method="POST" action="?/setUserPlan" class="plan-form">
								<input type="hidden" name="userId" value={account.id} />
								<select
									class="select"
									name="planId"
									aria-label="Plan for {account.email}"
									value={account.planId ?? ''}
								>
									<option value="">Default ({defaultPlan?.name ?? 'no limits'})</option>
									{#each data.plans as plan (plan.id)}
										<option value={plan.id}>{plan.name}</option>
									{/each}
								</select>
								<button type="submit" class="btn btn-ghost btn-sm">Set</button>
							</form>
						</td>
						<td class="num cell-nowrap" data-label="Universes">
							{usageText(account.universes, limits.max_universes, formatNumber)}
						</td>
						<td class="num cell-nowrap" data-label="Stories">
							{usageText(account.stories, limits.max_stories, formatNumber)}
						</td>
						<td class="num cell-nowrap" data-label="Images">
							{usageText(account.storageBytes, limits.storage_bytes, formatBytes)}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<form method="POST" action="?/recountStorage" class="settings-actions">
			<span class="field-hint">
				If the image totals look wrong, recount them from the files each account has stored.
			</span>
			<button type="submit" class="btn btn-ghost btn-sm">Recount images</button>
		</form>
	</div>
</div>

<style>
	.plan-form {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.plan-form .select {
		max-width: 12rem;
		padding: 3px 6px;
		font-size: 12.5px;
	}
	/* Below about 600px each account stacks, a label beside each value. */
	.usage-card {
		container-type: inline-size;
	}
	@container (max-width: 600px) {
		.usage-table thead {
			display: none;
		}
		.usage-table,
		.usage-table tbody,
		.usage-table tr,
		.usage-table td {
			display: block;
		}
		.usage-table tr {
			padding: 10px 0;
			border-bottom: 1px solid var(--border);
		}
		.usage-table td {
			padding: 4px 0;
			border-bottom: 0;
			text-align: left;
		}
		.usage-table td[data-label] {
			display: flex;
			align-items: center;
			gap: 12px;
		}
		.usage-table td[data-label]::before {
			content: attr(data-label);
			flex: none;
			width: 6rem;
			font-size: 12px;
			color: var(--text-faint);
		}
	}
</style>
