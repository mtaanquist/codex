<script lang="ts">
	import { page } from '$app/state';
	import type { Section } from './sections';
	import type { ActionData, PageData } from './$types';
	import AdminOverview from './AdminOverview.svelte';
	import AdminUsers from './AdminUsers.svelte';
	import AdminAi from './AdminAi.svelte';
	import AdminUsage from './AdminUsage.svelte';
	import AdminPlans from './AdminPlans.svelte';
	import AdminBackups from './AdminBackups.svelte';
	import AdminAudit from './AdminAudit.svelte';
	import AdminInstance from './AdminInstance.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The shell and its sidebar live in ../+layout.svelte. Forms post to the
	// section they sit on, so an action result lands where it belongs.
	let active: Section = $derived((page.params.section as Section) ?? 'overview');
</script>

<!-- ========== OVERVIEW ========== -->
<section class="admin-section" class:active={active === 'overview'}>
	<AdminOverview {data} />
</section>

<!-- ========== USERS & ACCESS ========== -->
<section class="admin-section" class:active={active === 'users'}>
	<AdminUsers {data} {form} />
</section>

<!-- ========== PLANS ========== -->
<section class="admin-section" class:active={active === 'plans'}>
	<AdminPlans {data} {form} />
</section>

<!-- ========== AI (stub) ========== -->
<section class="admin-section" class:active={active === 'ai'}>
	<AdminAi {data} {form} />
</section>

<!-- ========== USAGE & STORAGE ========== -->
<section class="admin-section" class:active={active === 'usage'}>
	<AdminUsage {data} {form} />
</section>

<!-- ========== BACKUPS ========== -->
<section class="admin-section" class:active={active === 'backups'}>
	<AdminBackups {data} {form} />
</section>

<!-- ========== AUDIT (stub) ========== -->
<section class="admin-section" class:active={active === 'audit'}>
	<AdminAudit />
</section>

<!-- ========== INSTANCE ========== -->
<section class="admin-section" class:active={active === 'instance'}>
	<AdminInstance {data} {form} />
</section>
