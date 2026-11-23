<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import FormStatus from '#lib/components/FormStatus.svelte';
	import { MEGABYTE } from '#lib/quota';
	import { formatNumber, pluralSuffix } from '#lib/format';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The form result that belongs to one plan's card.
	function planStatus(planId: string) {
		if (form?.scope !== 'plans' || !('planId' in form) || form.planId !== planId) return null;
		return form;
	}

	const limitValue = (n: number | null) => (n === null ? '' : String(n));
	const storageValue = (bytes: number | null) =>
		bytes === null ? '' : String(Math.round(bytes / MEGABYTE));
</script>

<div class="admin-head">
	<p class="admin-eyebrow">Instance</p>
	<h1 class="admin-title">Plans</h1>
	<p class="admin-lede">
		A plan sets how many universes and stories an account can have and how much space its uploaded
		images can take. Leave a limit blank for no limit. Accounts are on the default plan unless you
		pick another for them under Usage &amp; storage.
	</p>
</div>

{#if form?.scope === 'plans' && form.message && !('planId' in form && form.planId)}
	<div
		class="status-banner"
		style="background:var(--danger-soft);border:1px solid color-mix(in oklab, var(--danger) 32%, transparent);"
	>
		<span class="x">{form.message}</span>
	</div>
{/if}

{#each data.plans as plan (plan.id)}
	{@const status = planStatus(plan.id)}
	<div class="admin-block">
		<div class="admin-block-head">
			<div>
				<h2 class="admin-block-title">
					{plan.name}
					{#if plan.isDefault}<span class="pill">Default</span>{/if}
				</h2>
				<p class="admin-block-sub">
					{formatNumber(plan.accounts)} account{pluralSuffix(plan.accounts)}
				</p>
			</div>
		</div>
		<div class="admin-card">
			<form method="POST" action="?/savePlan">
				<input type="hidden" name="planId" value={plan.id} />
				<div class="field">
					<label for="plan-name-{plan.id}">Name</label>
					<input
						id="plan-name-{plan.id}"
						class="input short"
						type="text"
						name="name"
						maxlength="80"
						required
						value={plan.name}
					/>
				</div>
				<div class="field">
					<label for="plan-universes-{plan.id}">Universes</label>
					<input
						id="plan-universes-{plan.id}"
						class="input short"
						type="number"
						name="maxUniverses"
						min="0"
						placeholder="No limit"
						value={limitValue(plan.limits.max_universes)}
					/>
				</div>
				<div class="field">
					<label for="plan-stories-{plan.id}">Stories</label>
					<input
						id="plan-stories-{plan.id}"
						class="input short"
						type="number"
						name="maxStories"
						min="0"
						placeholder="No limit"
						value={limitValue(plan.limits.max_stories)}
					/>
				</div>
				<div class="field">
					<label for="plan-storage-{plan.id}">Image storage (MB)</label>
					<div>
						<input
							id="plan-storage-{plan.id}"
							class="input short"
							type="number"
							name="storageMb"
							min="0"
							placeholder="No limit"
							value={storageValue(plan.limits.storage_bytes)}
						/>
						<span class="field-hint">
							Counts uploaded images, covers, and avatars. Text does not count.
						</span>
					</div>
				</div>
				<div class="settings-actions">
					<FormStatus
						error={status?.message ?? null}
						success={status && 'saved' in status && status.saved ? 'Saved.' : null}
					/>
					{#if !plan.isDefault}
						<button type="submit" formaction="?/setDefaultPlan" class="btn btn-ghost">
							Make default
						</button>
					{/if}
					<button type="submit" class="btn btn-primary">Save</button>
				</div>
			</form>
		</div>
	</div>
{/each}

<div class="admin-block">
	<div class="admin-block-head">
		<h2 class="admin-block-title">New plan</h2>
	</div>
	<div class="admin-card">
		<form method="POST" action="?/createPlan">
			<div class="field">
				<label for="plan-new-name">Name</label>
				<input
					id="plan-new-name"
					class="input short"
					type="text"
					name="name"
					maxlength="80"
					required
				/>
			</div>
			<div class="settings-actions">
				<button type="submit" class="btn btn-primary">Create plan</button>
			</div>
		</form>
	</div>
</div>
