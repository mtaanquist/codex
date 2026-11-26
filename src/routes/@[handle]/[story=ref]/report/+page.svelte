<script lang="ts">
	import { resolve } from '$app/paths';
	import AuthShell from '#lib/components/AuthShell.svelte';
	import { MAX_REPORT_COMMENT, REPORT_REASONS } from '#lib/report-reasons';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const storyHref = $derived(
		resolve('/@[handle]/[story=ref]', { handle: data.handle, story: data.story })
	);
</script>

<svelte:head>
	<title>Report "{data.title}" - Codex</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<AuthShell title="Report this story" sub={data.title}>
	{#if form?.sent}
		<p class="auth-note" role="status">
			Thank you. The people who look after this site will read your report.
		</p>
	{:else}
		<form method="POST">
			<input type="hidden" name="editionId" value={data.editionId} />
			<p class="auth-lede">
				Tell the people who look after this site what is wrong. They can take the story down. Your
				report does not include your name or email address.
			</p>
			{#if form?.message}
				<p class="form-error" role="alert">{form.message}</p>
			{/if}
			<div class="field">
				<label for="report-reason">Reason</label>
				<select
					id="report-reason"
					class="select"
					name="reason"
					required
					value={form && 'reason' in form ? form.reason : ''}
				>
					<option value="" disabled>Pick a reason</option>
					{#each REPORT_REASONS as reason (reason.key)}
						<option value={reason.key}>{reason.label}</option>
					{/each}
				</select>
			</div>
			<div class="field">
				<label for="report-comment">Anything else (optional)</label>
				<textarea
					id="report-comment"
					class="textarea"
					name="comment"
					rows="4"
					maxlength={MAX_REPORT_COMMENT}>{form?.comment ?? ''}</textarea
				>
				<span class="field-hint">Up to {MAX_REPORT_COMMENT} characters.</span>
			</div>
			<div class="auth-actions">
				<button class="btn btn-primary" type="submit">Send report</button>
			</div>
		</form>
	{/if}
	<div class="auth-links">
		<a href={storyHref}>Back to the story</a>
	</div>
</AuthShell>
