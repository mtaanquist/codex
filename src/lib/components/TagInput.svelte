<script lang="ts">
	// A small list of short text tags shown as chips. Adding is hidden behind a
	// dashed chip so the row stays compact until you reach for it. Used for
	// character aliases and lore keywords, which feed mention detection.
	let {
		values,
		onChange,
		addLabel = 'Add',
		ariaLabel,
		suggestions = [],
		inputId
	}: {
		values: string[];
		onChange: (values: string[]) => void;
		addLabel?: string;
		ariaLabel?: string;
		// Offered as the browser's own completion list while typing.
		suggestions?: string[];
		// For a <label for> outside; the add button carries it until the
		// input opens.
		inputId?: string;
	} = $props();
	const listId = $props.id();

	let adding = $state(false);
	let draft = $state('');
	let inputEl = $state<HTMLInputElement>();

	function startAdding() {
		adding = true;
		queueMicrotask(() => inputEl?.focus());
	}

	function commit() {
		const value = draft.trim();
		draft = '';
		if (value && !values.includes(value)) {
			onChange([...values, value]);
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ',') {
			event.preventDefault();
			commit();
		} else if (event.key === 'Escape') {
			draft = '';
			adding = false;
		} else if (event.key === 'Backspace' && draft === '' && values.length > 0) {
			onChange(values.slice(0, -1));
		}
	}

	function onBlur() {
		commit();
		adding = false;
	}

	function remove(value: string) {
		onChange(values.filter((existing) => existing !== value));
	}
</script>

<div class="alias-row">
	{#each values as value (value)}
		<span class="chip">
			{value}
			<button
				type="button"
				class="chip-x"
				aria-label={`Remove ${value}`}
				onclick={() => remove(value)}
			>
				&times;
			</button>
		</span>
	{/each}
	{#if adding}
		<input
			class="chip-input"
			id={inputId}
			list={suggestions.length > 0 ? `${listId}-list` : undefined}
			bind:this={inputEl}
			bind:value={draft}
			onkeydown={onKeydown}
			onblur={onBlur}
			aria-label={ariaLabel ?? addLabel}
		/>
	{:else}
		<button type="button" id={inputId} class="chip dashed" onclick={startAdding}
			>+ {addLabel}</button
		>
	{/if}
	{#if suggestions.length > 0}
		<datalist id="{listId}-list">
			{#each suggestions as suggestion (suggestion)}
				<option value={suggestion}></option>
			{/each}
		</datalist>
	{/if}
</div>

<style>
	.chip-x {
		border: 0;
		background: none;
		color: var(--text-faint);
		font-size: 14px;
		line-height: 1;
		padding: 0;
		margin-left: 2px;
		cursor: pointer;
	}
	.chip-x:hover {
		color: var(--danger-ink);
	}
	.chip-input {
		background: var(--bg-inset);
		border: 1px solid var(--accent-line, var(--border));
		border-radius: 99px;
		color: var(--text);
		font-size: 12.5px;
		padding: 5px 11px;
		outline: none;
		width: 12ch;
	}
	.chip-input::placeholder {
		color: var(--text-faint);
	}
</style>
