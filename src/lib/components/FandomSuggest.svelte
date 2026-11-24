<script lang="ts">
	// A text box that offers close matches from the site's fandom list as the
	// writer types. It stays an ordinary text field: a pick only calls onPick.
	// Used for the new-universe name and the universe settings' fandom field.
	type Fandom = { id: string; name: string };
	let {
		value = $bindable(''),
		onPick,
		name,
		inputId,
		ariaLabel,
		placeholder = '',
		required = false,
		autofocus = false,
		onEscape
	}: {
		value?: string;
		onPick: (fandom: Fandom) => void;
		name?: string;
		inputId: string;
		ariaLabel?: string;
		placeholder?: string;
		required?: boolean;
		autofocus?: boolean;
		onEscape?: () => void;
	} = $props();

	let results = $state<Fandom[]>([]);
	let selected = $state(0);
	let open = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let latest = 0;
	const listId = $derived(`${inputId}-fandoms`);

	function search() {
		clearTimeout(timer);
		const query = value.trim();
		if (query.length < 2) {
			latest++;
			results = [];
			return;
		}
		timer = setTimeout(async () => {
			const ticket = ++latest;
			try {
				const response = await fetch(`/api/fandoms?q=${encodeURIComponent(query)}`);
				if (!response.ok || ticket !== latest) return;
				results = ((await response.json()) as { results: Fandom[] }).results;
				selected = 0;
				open = true;
			} catch {
				// Suggestions are a convenience; the field still works without them.
			}
		}, 200);
	}

	function pick(fandom: Fandom) {
		onPick(fandom);
		open = false;
		results = [];
	}

	function onKeydown(event: KeyboardEvent) {
		const showing = open && results.length > 0;
		if (event.key === 'Escape') {
			if (showing) {
				event.preventDefault();
				open = false;
			} else onEscape?.();
		} else if (showing && event.key === 'ArrowDown') {
			event.preventDefault();
			selected = (selected + 1) % results.length;
		} else if (showing && event.key === 'ArrowUp') {
			event.preventDefault();
			selected = (selected - 1 + results.length) % results.length;
		} else if (showing && event.key === 'Enter') {
			event.preventDefault();
			pick(results[selected]);
		}
	}
</script>

<span class="fandom-suggest">
	<!-- svelte-ignore a11y_autofocus (the field only appears on the writer's choice) -->
	<input
		id={inputId}
		class="input"
		type="text"
		{name}
		{placeholder}
		{required}
		{autofocus}
		aria-label={ariaLabel}
		role="combobox"
		aria-expanded={open && results.length > 0}
		aria-controls={listId}
		aria-autocomplete="list"
		aria-activedescendant={open && results[selected]
			? `${listId}-${results[selected].id}`
			: undefined}
		autocomplete="off"
		bind:value
		oninput={search}
		onkeydown={onKeydown}
		onblur={() => (open = false)}
	/>
	<div
		class="fandom-suggest-list popover"
		id={listId}
		role="listbox"
		aria-label="Known settings"
		hidden={!open || results.length === 0}
	>
		<div class="menu-heading" aria-hidden="true">Known settings</div>
		{#each results as fandom, index (fandom.id)}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div
				id="{listId}-{fandom.id}"
				class="menu-item"
				class:active={index === selected}
				role="option"
				tabindex="-1"
				aria-selected={index === selected}
				onmousedown={(event) => event.preventDefault()}
				onmouseenter={() => (selected = index)}
				onclick={() => pick(fandom)}
			>
				{fandom.name}
			</div>
		{/each}
	</div>
</span>

<style>
	.fandom-suggest {
		position: relative;
		display: inline-block;
		flex: 1;
		min-width: 14rem;
	}
	.fandom-suggest .input {
		width: 100%;
	}
	.fandom-suggest-list {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		z-index: 30;
	}
	.fandom-suggest-list[hidden] {
		display: none;
	}
</style>
