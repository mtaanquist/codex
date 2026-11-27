<script lang="ts">
	import { withQuery } from '#lib/href';
	import type { ResolvedPathname } from '$app/types';
	import { goto, refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { deserialize } from '$app/forms';
	import { closePalette, openPalette, palette } from '#lib/palette.svelte';
	import { modal } from '#lib/modal';
	import { focusMode } from '#lib/focus-mode.svelte';
	import { assistantIntent } from '#lib/assistant.svelte';
	import { openReviewModal } from '#lib/review-modal.svelte';
	import { openQuickNote } from '#lib/quick-note.svelte';
	import { openFindReplace } from '#lib/find-replace.svelte';
	import { startSummariesJob } from '#lib/assistant-actions';
	import type { MeaningResult, SearchResult } from '#lib/wire-types';

	// The command palette: Ctrl+K (or the topbar button) opens it; type to
	// search everything you own and to filter the commands that fit where
	// you are; arrows move, Enter runs, Escape closes. Inside a universe with
	// a search index it also searches by meaning, which embeds the query with
	// the writer's paid model, so that search runs on Enter only.

	type Item = {
		label: string;
		sublabel: string | null;
		kind: string;
		passage?: string;
		run: () => void | Promise<void>;
	};

	let query = $state('');
	let results = $state<SearchResult[]>([]);
	let selected = $state(0);
	let inputEl = $state<HTMLInputElement>();
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	// Bumped on every search; a stale in-flight fetch checks it and bails.
	let searchSeq = 0;
	let listEl = $state<HTMLDivElement>();

	// By meaning: offered only when the open page's universe has an index.
	let mode = $state<'words' | 'meaning'>('words');
	let meaningUniverseId = $state<string | null>(null);
	let meaningResults = $state<MeaningResult[]>([]);
	let meaningState = $state<'idle' | 'searching' | 'done' | 'error'>('idle');
	let meaningError = $state('');
	// The query the shown meaning results are for; Enter on a changed query
	// searches again, Enter on the same one opens the highlighted scene.
	let meaningQuery = $state('');
	let meaningSeq = 0;

	const TYPE_LABELS: Record<string, string> = {
		universe: 'Universe',
		story: 'Story',
		scene: 'Scene',
		character: 'Character',
		place: 'Place',
		lore: 'Lore',
		passage: 'In the text'
	};

	function navigate(href: ResolvedPathname): () => Promise<void> {
		return async () => {
			closePalette();
			await goto(href);
		};
	}

	// Posts one of the story page's form actions (new chapter, new scene)
	// and follows the redirect or refreshes, depending on what it returns.
	function storyAction(storyRef: string, action: string): () => Promise<void> {
		return async () => {
			closePalette();
			const response = await fetch(`/stories/${storyRef}?/${action}`, {
				method: 'POST',
				headers: { 'x-sveltekit-action': 'true' },
				body: new FormData()
			});
			const result = deserialize(await response.text());
			if (result.type === 'redirect') {
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- the action's own redirect
				await goto(result.location, { refreshAll: true });
			} else {
				await refreshAll();
			}
		};
	}

	// Navigation and action commands that make sense where the user is.
	const commands = $derived.by((): Item[] => {
		const path = page.url.pathname;
		const list: Item[] = [];
		const storyMatch = path.match(/^\/stories\/([^/]+)/);
		const universeMatch = path.match(/^\/universes\/([^/]+)/);
		// Focus mode only exists on the write page itself.
		if (/^\/stories\/[^/]+$/.test(path)) {
			list.push({
				label: focusMode.on ? 'Leave focus mode' : 'Focus mode',
				sublabel: 'Just the prose, nothing else',
				kind: 'Command',
				run: () => {
					focusMode.on = !focusMode.on;
					closePalette();
				}
			});
			list.push({
				label: 'Quick note',
				sublabel: 'Jot a note without leaving the editor',
				kind: 'Command',
				run: () => {
					closePalette();
					openQuickNote();
				}
			});
			list.push({
				label: 'Find and replace in the story',
				sublabel: 'Change a word or phrase in every scene',
				kind: 'Command',
				run: () => {
					closePalette();
					openFindReplace({ chapterId: null });
				}
			});
			// The Assistant's quick actions, gated like its other surfaces; the
			// write page's data carries the gate and the open story.
			const assistant = page.data.assistant as
				{ surfacesEnabled: boolean; name: string } | undefined;
			const storyId = (page.data.story as { id: string; slug: string } | undefined)?.id;
			const storySlug = (page.data.story as { id: string; slug: string } | undefined)?.slug;
			const sceneId = (page.data.selectedScene as { id: string } | null | undefined)?.id;
			if (assistant?.surfacesEnabled && storyId && storySlug) {
				list.push(
					{
						label: 'Ask the Assistant',
						sublabel: 'Open the chat on the right',
						kind: 'Command',
						run: () => {
							assistantIntent.pending = { kind: 'focus' };
							closePalette();
						}
					},
					{
						label: 'Catch me up',
						sublabel: 'A recap of the story so far',
						kind: 'Command',
						run: () => {
							assistantIntent.pending = { kind: 'catchup' };
							closePalette();
						}
					},
					{
						label: 'Update summaries',
						sublabel: 'Draft and refresh scene and chapter summaries',
						kind: 'Command',
						run: async () => {
							closePalette();
							await startSummariesJob(storyId);
						}
					}
				);
				list.push({
					label: 'Review with the Assistant',
					sublabel: sceneId
						? 'Comments and suggested edits, by scene, chapter, or story'
						: 'Comments and suggested edits, by chapter or story',
					kind: 'Command',
					run: () => {
						closePalette();
						openReviewModal(sceneId ? { level: 'scene', sceneId } : { level: 'story' });
					}
				});
			}
		}
		if (storyMatch) {
			const storyRef = storyMatch[1];
			list.push(
				{
					label: 'New scene',
					sublabel: null,
					kind: 'Command',
					run: storyAction(storyRef, 'createScene')
				},
				{
					label: 'New chapter',
					sublabel: null,
					kind: 'Command',
					run: storyAction(storyRef, 'createChapter')
				},
				{
					label: 'Write',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/stories/[id]', { id: storyRef }))
				},
				{
					label: 'Read the whole story',
					sublabel: 'Every scene as one continuous document',
					kind: 'Go to',
					run: navigate(withQuery(resolve('/stories/[id]', { id: storyRef }), { view: 'story' }))
				},
				{
					label: 'Preview the story',
					sublabel: 'See how it will look when exported',
					kind: 'Go to',
					run: navigate(withQuery(resolve('/stories/[id]', { id: storyRef }), { view: 'preview' }))
				},
				{
					label: 'Plan this story',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/stories/[id]/plan', { id: storyRef }))
				},
				{
					label: 'Story notes',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/stories/[id]/notes', { id: storyRef }))
				},
				{
					label: 'Story settings',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/stories/[id]/settings/[[section]]', { id: storyRef }))
				},
				{
					label: 'Review feedback',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/stories/[id]/review', { id: storyRef }))
				}
			);
		}
		if (universeMatch) {
			const universeRef = universeMatch[1];
			list.push(
				{
					label: 'Plan this universe',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/universes/[id]/plan', { id: universeRef }))
				},
				{
					label: 'Universe notes',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/universes/[id]/notes', { id: universeRef }))
				},
				{
					label: 'Universe insights',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/universes/[id]/insights', { id: universeRef }))
				},
				{
					label: 'Universe settings',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/universes/[id]/[[section]]', { id: universeRef }))
				}
			);
		}
		list.push(
			{ label: 'Library', sublabel: null, kind: 'Go to', run: navigate(resolve('/')) },
			{
				label: 'Account settings',
				sublabel: null,
				kind: 'Go to',
				run: navigate(resolve('/account/[[section]]', {}))
			},
			{ label: 'Help', sublabel: null, kind: 'Go to', run: navigate(resolve('/docs')) }
		);
		// The admin sections, for the people who run the instance.
		if (page.data.user?.isAdmin) {
			list.push(
				{
					label: 'Admin: overview',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/admin/[[section]]', {}))
				},
				{
					label: 'Admin: users & access',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/admin/[[section]]', { section: 'users' }))
				},
				{
					label: 'Admin: published',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/admin/published'))
				},
				{
					label: 'Admin: reports',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/admin/reports'))
				},
				{
					label: 'Admin: usage & storage',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/admin/[[section]]', { section: 'usage' }))
				},
				{
					label: 'Admin: backups',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/admin/[[section]]', { section: 'backups' }))
				},
				{
					label: 'Admin: instance',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/admin/[[section]]', { section: 'instance' }))
				}
			);
		} else if (page.data.user?.isModerator) {
			list.push(
				{
					label: 'Moderation: reports',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/admin/reports'))
				},
				{
					label: 'Moderation: published',
					sublabel: null,
					kind: 'Go to',
					run: navigate(resolve('/admin/published'))
				}
			);
		}
		return list;
	});

	const matchingCommands = $derived(
		commands.filter((command) => command.label.toLowerCase().includes(query.trim().toLowerCase()))
	);

	const meaningItems = $derived.by((): Item[] =>
		meaningResults.map((result) => ({
			label: result.sceneTitle ?? 'Untitled scene',
			sublabel: result.storyTitle,
			kind: 'Scene',
			passage: result.passage,
			// The search endpoint builds each href as an app path.
			run: navigate(result.href as ResolvedPathname)
		}))
	);

	const wordItems = $derived.by((): Item[] => [
		...matchingCommands,
		...results.map((result) => ({
			label: result.label,
			sublabel: result.sublabel,
			kind: TYPE_LABELS[result.type] ?? result.type,
			// A text match carries the search along, so the editor can select
			// the occurrence it lands on.
			// The search endpoint builds each href as an app path.
			run: navigate(
				result.type === 'passage'
					? withQuery(result.href as ResolvedPathname, { find: query.trim() })
					: (result.href as ResolvedPathname)
			)
		}))
	]);

	const items = $derived(mode === 'meaning' ? meaningItems : wordItems);
	// Enter searches by meaning until the shown results are for the query.
	const meaningPending = $derived(
		mode === 'meaning' && (query.trim() !== meaningQuery || meaningState !== 'done')
	);

	// Which universe the open page belongs to, for the meaning search.
	let checkSeq = 0;
	async function checkMeaning() {
		const seq = ++checkSeq;
		meaningUniverseId = null;
		const path = page.url.pathname;
		const storyRef = path.match(/^\/stories\/([^/]+)/)?.[1];
		const universeRef = path.match(/^\/universes\/([^/]+)/)?.[1];
		if (!storyRef && !universeRef) return;
		const params: Record<string, string> = storyRef
			? { story: storyRef }
			: { universe: universeRef! };
		const response = await fetch(`/api/search/meaning?${new URLSearchParams(params)}`).catch(
			() => null
		);
		if (!response?.ok) return;
		const data = (await response.json().catch(() => null)) as { universeId: string | null } | null;
		if (seq !== checkSeq || !palette.open) return;
		meaningUniverseId = data?.universeId ?? null;
	}

	function setMode(next: 'words' | 'meaning') {
		mode = next;
		selected = 0;
		inputEl?.focus();
		if (next === 'words') search();
	}

	async function searchByMeaning() {
		const value = query.trim();
		if (!value || !meaningUniverseId) return;
		const seq = ++meaningSeq;
		meaningQuery = value;
		meaningState = 'searching';
		meaningError = '';
		meaningResults = [];
		const response = await fetch('/api/search/meaning', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ universeId: meaningUniverseId, query: value })
		}).catch(() => null);
		const data = response ? await response.json().catch(() => null) : null;
		if (seq !== meaningSeq) return;
		if (!response?.ok || !data) {
			meaningState = 'error';
			meaningError = response
				? (data?.message ?? 'Could not search. Try again in a moment.')
				: 'Could not search. Check your connection and try again.';
			return;
		}
		meaningResults = data.results;
		meaningState = 'done';
		selected = 0;
	}

	function search() {
		clearTimeout(searchTimer);
		if (mode === 'meaning') return;
		// The matching commands change as you type, so the highlight starts over.
		selected = 0;
		const value = query.trim();
		if (value === '') {
			searchSeq++;
			results = [];
			selected = 0;
			return;
		}
		searchTimer = setTimeout(async () => {
			// A sequence guard: a slow response for an earlier query must not land
			// after a faster one for a later query and replace newer results.
			const seq = ++searchSeq;
			// A network failure just leaves the previous results standing.
			const response = await fetch(`/api/search?q=${encodeURIComponent(value)}`).catch(() => null);
			if (!response || seq !== searchSeq || !response.ok) return;
			const data = await response.json();
			if (seq !== searchSeq) return;
			results = data.results;
			selected = 0;
		}, 150);
	}

	function onGlobalKey(event: KeyboardEvent) {
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			if (palette.open) closePalette();
			else openPalette();
		}
	}

	function onPaletteKey(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selected = Math.max(Math.min(selected + 1, items.length - 1), 0);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			selected = Math.max(selected - 1, 0);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (meaningPending) {
				if (meaningState !== 'searching') void searchByMeaning();
			} else {
				void items[selected]?.run();
			}
		}
	}

	$effect(() => {
		if (palette.open) {
			query = '';
			results = [];
			selected = 0;
			mode = 'words';
			meaningSeq++;
			meaningResults = [];
			meaningState = 'idle';
			meaningError = '';
			meaningQuery = '';
			inputEl?.focus();
			void checkMeaning();
		}
	});

	// Keep the highlighted result visible: past a screenful the keyboard
	// selection would otherwise scroll out of the list while Enter still ran it.
	$effect(() => {
		void selected;
		listEl?.querySelector('.menu-item.active')?.scrollIntoView({ block: 'nearest' });
	});
</script>

<svelte:window onkeydown={onGlobalKey} />

{#if palette.open}
	<div
		class="modal-backdrop top"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget) closePalette();
		}}
	>
		<div
			class="modal-panel modal-lg"
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
			use:modal={{ close: closePalette, initialFocus: '.modal-search' }}
		>
			<div class="modal-head searching">
				<input
					bind:this={inputEl}
					bind:value={query}
					oninput={search}
					onkeydown={onPaletteKey}
					class="modal-search"
					type="text"
					placeholder={mode === 'meaning'
						? 'Describe a moment, then press Enter'
						: 'Search, or type a command...'}
					aria-label={mode === 'meaning' ? 'Search by meaning' : 'Search everything'}
					maxlength={mode === 'meaning' ? 500 : undefined}
					role="combobox"
					aria-expanded="true"
					aria-controls="palette-results"
					aria-activedescendant={items.length > 0 ? `palette-option-${selected}` : undefined}
				/>
				{#if meaningUniverseId}
					<div class="seg palette-mode" role="group" aria-label="Search by">
						<button
							class="seg-btn"
							class:active={mode === 'words'}
							type="button"
							aria-pressed={mode === 'words'}
							onclick={() => setMode('words')}
						>
							Words
						</button>
						<button
							class="seg-btn"
							class:active={mode === 'meaning'}
							type="button"
							aria-pressed={mode === 'meaning'}
							onclick={() => setMode('meaning')}
						>
							Meaning
						</button>
					</div>
				{/if}
			</div>
			<div
				class="modal-body rows"
				id="palette-results"
				role="listbox"
				aria-label="Results"
				bind:this={listEl}
			>
				{#each items as item, index (index)}
					<button
						class="menu-item"
						class:active={index === selected}
						id="palette-option-{index}"
						role="option"
						aria-selected={index === selected}
						tabindex="-1"
						type="button"
						onmouseenter={() => (selected = index)}
						onclick={() => void item.run()}
					>
						<span class="palette-kind">{item.kind}</span>
						<span class="palette-label">{item.label}</span>
						{#if item.sublabel}
							<span class="palette-sub">{item.sublabel}</span>
						{/if}
						{#if item.passage}
							<span class="palette-passage">{item.passage}</span>
						{/if}
					</button>
				{/each}
				{#if mode === 'meaning' && meaningState === 'error'}
					<div class="empty-state tight" role="alert">
						<p class="empty-state-text">{meaningError}</p>
					</div>
				{:else if mode === 'meaning' && meaningState === 'searching'}
					<div class="empty-state tight" role="status">
						<p class="empty-state-text">Searching...</p>
					</div>
				{:else if mode === 'meaning' && items.length === 0}
					<div class="empty-state tight">
						<p class="empty-state-text">
							{meaningState === 'done' && !meaningPending
								? 'No scenes found.'
								: 'Describe what happens in the scene you are looking for, such as "someone lies to protect a friend", and press Enter.'}
						</p>
					</div>
				{:else if items.length === 0}
					<div class="empty-state tight">
						<p class="empty-state-text">Nothing matches.</p>
					</div>
				{/if}
			</div>
			<div class="modal-foot">
				<div class="modal-foot-note">
					<span><kbd>&uarr;</kbd><kbd>&darr;</kbd> to choose</span>
					<span><kbd>Enter</kbd> to {meaningPending ? 'search' : 'open'}</span>
					<span><kbd>Esc</kbd> to close</span>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Row content only: the overlay, the rows and the footer come from the
	   modal, menu-item and empty-state primitives. */
	.palette-kind {
		flex: 0 0 72px;
		font-size: var(--text-micro);
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.palette-label {
		font-weight: 550;
	}
	.palette-sub {
		color: var(--text-faint);
		font-size: var(--text-sm);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.palette-mode {
		flex: none;
	}
	/* The matching passage, on its own line under the scene and story. */
	.menu-item:has(.palette-passage) {
		flex-wrap: wrap;
	}
	.palette-passage {
		flex-basis: 100%;
		padding-left: 80px;
		color: var(--text-muted);
		font-size: var(--text-sm);
		line-height: 1.45;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.modal-foot-note {
		gap: 14px;
	}
	.modal-foot-note kbd {
		margin-right: 2px;
	}
</style>
