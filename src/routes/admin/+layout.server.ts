import type { LayoutServerLoad } from './$types';
import { db } from '#lib/server/db';
import { requireModerator } from '#lib/server/roles';
import { instanceStats } from '#lib/server/admin';
import { effectiveBackupConfig } from '#lib/server/backups';
import { smtpView } from '#lib/server/settings';
import { appVersion } from '#lib/server/app-version';
import { countOpenReports } from '#lib/server/reports';

// A compact uptime for the sidebar footer: minutes, then hours, then days.
function formatUptime(seconds: number): string {
	if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

// The whole area is for admins and moderators; each page checks its own role
// as well, because a layout load does not guard the actions.
export const load: LayoutServerLoad = async ({ locals }) => {
	requireModerator(locals);
	const openReports = await countOpenReports(db);
	if (locals.user!.role !== 'admin') return { openReports, health: null };
	return {
		openReports,
		// The sidebar's badges and health box, for admins only.
		health: {
			stats: await instanceStats(db),
			backupsConfigured: (await effectiveBackupConfig(db)) !== null,
			emailReady: (await smtpView(db)).source !== 'none',
			version: appVersion(),
			uptime: formatUptime(process.uptime())
		}
	};
};
