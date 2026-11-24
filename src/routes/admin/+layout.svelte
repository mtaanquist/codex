<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import AppBar from '#lib/components/AppBar.svelte';
	import { libraryCrumb, pageCrumb } from '#lib/chrome';
	import SettingsShell from '#lib/components/SettingsShell.svelte';
	import type { Section } from './[[section]]/sections';
	import type { LayoutData } from './$types';
	import type { Snippet } from 'svelte';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	// Each section is its own page (/admin/users, /admin/backups, ...); a plain
	// /admin is the overview. The moderation pages have routes of their own,
	// because moderators reach them too. Moderators see only those (data.health
	// is null for them).
	let active: string = $derived(
		page.route.id === '/admin/[[section]]'
			? ((page.params.section as Section) ?? 'overview')
			: (page.route.id?.split('/')[2] ?? '')
	);

	function sectionHref(section: Section): ResolvedPathname {
		return resolve('/admin/[[section]]', {
			section: section === 'overview' ? undefined : section
		});
	}
</script>

<svelte:head>
	<title>{data.health ? 'Site admin' : 'Moderation'} - Codex</title>
</svelte:head>

<SettingsShell wide={active === 'overview' || active === 'users'}>
	{#snippet topbar()}
		<AppBar crumbs={[libraryCrumb(), pageCrumb(data.health ? 'Site admin' : 'Moderation')]} />
	{/snippet}
	{#snippet sidebar()}
		<div class="admin-sidebar-title">
			<span class="ic">
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V5z" /></svg
				>
			</span>
			<div>
				<div class="tt">Administration</div>
				<div class="st">Codex instance</div>
			</div>
		</div>

		<nav class="admin-nav">
			{#if data.health}
				<div class="admin-nav-label">Instance</div>
				<a class="nav-item" class:active={active === 'overview'} href={sectionHref('overview')}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
						><rect x="3" y="3" width="7" height="9" rx="1" /><rect
							x="14"
							y="3"
							width="7"
							height="5"
							rx="1"
						/><rect x="14" y="12" width="7" height="9" rx="1" /><rect
							x="3"
							y="16"
							width="7"
							height="5"
							rx="1"
						/></svg
					>
					<span class="lbl">Overview</span>
				</a>
				<a class="nav-item" class:active={active === 'users'} href={sectionHref('users')}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle
							cx="9"
							cy="7"
							r="4"
						/><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg
					>
					<span class="lbl">Users &amp; access</span>
					{#if data.health.stats.pending > 0}<span class="nav-badge"
							>{data.health.stats.pending}</span
						>{/if}
				</a>
				<a class="nav-item" class:active={active === 'plans'} href={sectionHref('plans')}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
						><rect x="3" y="4" width="18" height="16" rx="2" /><path
							d="M7 9h10M7 13h6M7 17h4"
						/></svg
					>
					<span class="lbl">Plans</span>
				</a>
				<a class="nav-item" class:active={active === 'ai'} href={sectionHref('ai')}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path
							d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M17.7 6.3l1.4-1.4M4.9 19.1l1.4-1.4"
						/><circle cx="12" cy="12" r="4" /></svg
					>
					<span class="lbl">AI</span>
				</a>

				<div class="admin-nav-label">Data</div>
				<a class="nav-item" class:active={active === 'usage'} href={sectionHref('usage')}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path d="M3 3v18h18" /><rect x="7" y="11" width="3" height="6" rx="0.5" /><rect
							x="12.5"
							y="7"
							width="3"
							height="10"
							rx="0.5"
						/><rect x="18" y="13" width="3" height="4" rx="0.5" /></svg
					>
					<span class="lbl">Usage &amp; storage</span>
				</a>
				<a class="nav-item" class:active={active === 'backups'} href={sectionHref('backups')}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
						><ellipse cx="12" cy="5" rx="8" ry="3" /><path
							d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"
						/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" /></svg
					>
					<span class="lbl">Backups</span>
					{#if !data.health.backupsConfigured}<span class="nav-badge muted">!</span>{/if}
				</a>
				<a class="nav-item" class:active={active === 'audit'} href={sectionHref('audit')}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"><path d="M3 12h4l2 5 4-12 2 7h6" /></svg
					>
					<span class="lbl">Audit log</span>
					<span class="nav-badge muted">soon</span>
				</a>

				<div class="admin-nav-label">Configuration</div>
				<a class="nav-item" class:active={active === 'instance'} href={sectionHref('instance')}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path d="M4 4h16v16H4z" fill="none" /><path d="m22 6-10 7L2 6" /><rect
							x="2"
							y="4"
							width="20"
							height="16"
							rx="2"
						/></svg
					>
					<span class="lbl">Instance</span>
				</a>
			{/if}
			<div class="admin-nav-label">Moderation</div>
			<a class="nav-item" class:active={active === 'published'} href={resolve('/admin/published')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path
						d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"
					/></svg
				>
				<span class="lbl">Published</span>
			</a>
			<a class="nav-item" class:active={active === 'reports'} href={resolve('/admin/reports')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M5 21V4h11l-1.5 4L16 12H5" /></svg
				>
				<span class="lbl">Reports</span>
				{#if data.openReports > 0}<span class="nav-badge">{data.openReports}</span>{/if}
			</a>
			<a class="nav-item" class:active={active === 'tags'} href={resolve('/admin/tags')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
					><path d="M20 12 12 20 3 11V3h8z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg
				>
				<span class="lbl">Tags</span>
			</a>
			<a class="nav-item" class:active={active === 'fandoms'} href={resolve('/admin/fandoms')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 3v18M3 12h18" /></svg
				>
				<span class="lbl">Fandoms</span>
			</a>
			<a class="nav-item" class:active={active === 'genres'} href={resolve('/admin/genres')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M4 5h16M4 12h16M4 19h10" /></svg
				>
				<span class="lbl">Genres</span>
			</a>
			<a class="nav-item" class:active={active === 'warnings'} href={resolve('/admin/warnings')}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17h.01" /></svg
				>
				<span class="lbl">Content warnings</span>
			</a>
		</nav>
		{#if data.health}
			<div class="admin-health">
				<div class="admin-health-row">
					<span
						class="dot"
						class:ok={data.health.backupsConfigured}
						class:warn={!data.health.backupsConfigured}
					></span>
					<span class="k">Backups</span>
					<span class="v">{data.health.backupsConfigured ? 'On' : 'Off'}</span>
				</div>
				<div class="admin-health-row">
					<span class="dot" class:ok={data.health.emailReady} class:warn={!data.health.emailReady}
					></span>
					<span class="k">Email relay</span>
					<span class="v">{data.health.emailReady ? 'Configured' : 'Console'}</span>
				</div>
				<div class="admin-health-meta">codex v{data.health.version} · up {data.health.uptime}</div>
			</div>
		{/if}
	{/snippet}

	{@render children()}
</SettingsShell>
