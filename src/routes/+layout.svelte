<script lang="ts">
	import '@fontsource-variable/hanken-grotesk/index.css';
	import '@fontsource/spectral/400.css';
	import '@fontsource/spectral/400-italic.css';
	import '@fontsource/spectral/500.css';
	import '@fontsource/spectral/600.css';
	import '@fontsource-variable/jetbrains-mono/index.css';
	import '#lib/styles/tokens.css';
	import '#lib/styles/theme.css';
	import '#lib/styles/board.css';
	import '#lib/styles/pages.css';
	import '#lib/styles/admin.css';
	import '#lib/styles/editor.css';
	import '#lib/styles/review.css';
	import '#lib/styles/menus.css';
	// Late, so the consolidated primitives win over any screen-local skin.
	import '#lib/styles/primitives.css';
	// Late: the one navigation bar, which beats the bars it replaces.
	import '#lib/styles/chrome.css';
	// Last of all: the secondary surfaces (right-pane panels, the reader, the
	// creation menus), so they beat any screen-local skin they replace.
	import '#lib/styles/surfaces.css';
	// After the surfaces, because the signed-out pages reuse the reading pages'
	// footer and the shared primitives and then set their own type on top.
	import '#lib/styles/public.css';
	import favicon from '#lib/assets/favicon.svg';
	import { browser } from '$app/env';
	import { applyAppearance } from '#lib/appearance-apply';
	import { followSystemTheme } from '#lib/theme';
	import { TIMEZONE_COOKIE, TIMEZONE_TRIED_KEY, browserTimeZone } from '#lib/timezone';
	import { beforeNavigate, goto, refreshAll } from '$app/navigation';
	import { withRememberedAdult } from '#lib/browse';
	import { browseAdultRemembered, syncBrowseAdult } from '#lib/browse-adult.svelte';
	import CommandPalette from '#lib/components/CommandPalette.svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import ActivityCenter from '#lib/components/ActivityCenter.svelte';
	import { watchRunningJobs } from '#lib/assistant-actions';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let { children, data }: { children: Snippet; data: LayoutData } = $props();

	// Every page has one main with id="main", which the link targets. Moving
	// focus by hand puts the next Tab inside main in every browser; tabindex
	// lets a non-control take focus.
	function skipToMain(event: MouseEvent) {
		const main = document.getElementById('main');
		if (!main) return;
		event.preventDefault();
		if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
		main.focus();
	}

	// Marks the document once the client has taken over. Server-rendered markup
	// is clickable before its handlers are attached, so a test that clicks
	// straight after a navigation can hit a button that does nothing; this gives
	// the end-to-end suite something to wait for. Effects only run in the
	// browser, and only once the component tree is mounted.
	$effect(() => {
		document.documentElement.dataset.hydrated = 'true';
	});

	// Times render on the author's clock. The server learns it from a cookie;
	// on the first visit (or a changed clock) set it and reload the data once,
	// so every time on the page re-renders in the right zone.
	// Once per tab: a zone the server does not know comes back as UTC, and
	// asking again would reload the data on every page load.
	let timeZoneSent = false;
	$effect(() => {
		const timeZone = browserTimeZone();
		if (timeZone && timeZone === data.timeZone) {
			// Accepted: if the cookie goes missing later, set it again.
			try {
				sessionStorage.removeItem(TIMEZONE_TRIED_KEY);
			} catch {
				// No storage.
			}
			return;
		}
		if (timeZoneSent || !timeZone) return;
		timeZoneSent = true;
		try {
			if (sessionStorage.getItem(TIMEZONE_TRIED_KEY) === timeZone) return;
			sessionStorage.setItem(TIMEZONE_TRIED_KEY, timeZone);
		} catch {
			// No storage (a private window): fall back to once per page load.
		}
		const secure = location.protocol === 'https:' ? '; secure' : '';
		document.cookie = `${TIMEZONE_COOKIE}=${encodeURIComponent(timeZone)}; path=/; max-age=31536000; samesite=lax${secure}`;
		void refreshAll();
	});

	// Browse includes adult work when the reader chose that on this device.
	// Links to it read the choice once mounted; any other navigation into
	// Browse is sent to adult=show here, before its data loads, so the page
	// is not fetched (and counted against its rate limit) twice.
	$effect(() => syncBrowseAdult());
	beforeNavigate((navigation) => {
		const to = navigation.to;
		// A full page load is left to the pre-paint script, and going back to an
		// older entry to the universal load.
		if (navigation.willUnload || navigation.type === 'popstate') return;
		if (!to || to.route.id !== '/browse') return;
		const target = withRememberedAdult(to.url, browseAdultRemembered());
		if (!target) return;
		navigation.cancel();
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- the navigation's own address
		void goto(target);
	});

	// With no theme choice stored on this device, the palette follows the system
	// and keeps following it while the page is open. A reader who has not chosen
	// gets the theme their system asks for, including when it changes mid-page.
	$effect(() => followSystemTheme());

	// Pick up the Assistant jobs still running from before this page loaded or
	// started in another tab, so their activity cards and the story's run note
	// show here too.
	const signedIn = $derived(Boolean(data.user));
	$effect(() => {
		if (signedIn) return watchRunningJobs();
	});

	// Apply the signed-in user's saved theme and accent, syncing the pre-paint
	// keys so the next load matches without a flash.
	$effect(() => {
		if (!browser || !data.appearance) return;
		applyAppearance(
			data.appearance.theme,
			data.appearance.accent,
			data.appearance.systemLightTheme,
			data.appearance.systemDarkTheme
		);
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<a class="skip-link" href="#main" onclick={skipToMain}>Skip to content</a>
{@render children()}
<ConfirmDialog />
{#if data.user}
	<CommandPalette />
	<ActivityCenter />
{/if}
