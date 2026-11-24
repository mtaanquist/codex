import { error, fail, redirect } from '@sveltejs/kit';
import { isUuid } from '#lib/slug';
import { EMAIL_RE } from '#lib/server/signup';
import { isSectionSlug } from './sections';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { requireAdmin } from '#lib/server/roles';
import {
	approveUser,
	confirmUserEmail,
	instanceStats,
	listAllUsers,
	rejectUser,
	setUserArchive,
	setUserRole,
	setUserSuspended
} from '#lib/server/admin';
import {
	backupStorageView,
	effectiveBackupConfig,
	listRecentBackupRuns,
	saveBackupStorage
} from '#lib/server/backups';
import { applyBackupSchedule, queueAssetMigration, queueBackup } from '#lib/server/jobs';
import { probeS3 } from '#lib/server/s3-client';
import {
	createInviteCode,
	deleteInviteCode,
	listInviteCodes,
	setInviteAllowance
} from '#lib/server/invites';
import { listPublications } from '#lib/server/publish';
import {
	instanceType,
	saveInstanceType,
	saveSignupMode,
	saveSmtp,
	SIGNUP_MODES,
	signupMode,
	smtpView,
	type SignupMode
} from '#lib/server/settings';
import { INSTANCE_TYPES, type InstanceType } from '#lib/instance-type';
import { secretsAvailable } from '#lib/server/crypto';
import { egressPolicy, saveEgressPolicy, type EgressPolicyName } from '#lib/server/llm/egress';
import { mcpInstanceEnabled, saveMcpInstanceEnabled } from '#lib/server/mcp/settings';
import { logEvent } from '#lib/server/log';
import { sendEmail } from '#lib/server/email';
import { adminCancelDeletion, purgeAccount } from '#lib/server/account-deletion';
import { disableTotp } from '#lib/server/two-factor';
import {
	assetMigrationResult,
	assetMigrationSource,
	assetStorageView,
	clearAssetMigrationSource,
	effectiveAssetConfig,
	s3AssetStore,
	saveAssetStorage
} from '#lib/server/assets';
import {
	createPlan,
	listAccountUsage,
	listPlans,
	recountStorageBatch,
	savePlan,
	setDefaultPlan,
	setUserPlan
} from '#lib/server/plans';
import { MAX_IMAGE_BYTES, MEGABYTE, parseLimitInput, parseMegabytesField } from '#lib/quota';
import { eq } from 'drizzle-orm';
import { users } from '#lib/server/db/schema';
import { formText } from '#lib/server/validation';

// Upper bounds for typed limits, well past any real use.
const MAX_COUNT_LIMIT = 100_000;
const MAX_STORAGE_MB = 100_000_000;

export const load: PageServerLoad = async ({ locals, params, url }) => {
	// A moderator's way in is the moderation pages; plain /admin sends them there.
	if (locals.user?.role === 'moderator' && params.section === undefined) {
		redirect(303, '/admin/reports');
	}
	requireAdmin(locals);
	// Older links carried the section as a query string; send them to the
	// section's own page.
	const legacy = url.searchParams.get('section');
	if (legacy && isSectionSlug(legacy)) redirect(308, `/admin/${legacy}`);
	// The overview rests on /admin itself; anything else must be a known slug.
	if (params.section !== undefined && !isSectionSlug(params.section)) error(404, 'Not found');
	const section = params.section ?? 'overview';
	return {
		meId: locals.user!.id,
		meEmail: locals.user!.email,
		stats: await instanceStats(db),
		signup: await signupMode(db),
		instanceType: await instanceType(db),
		users: await listAllUsers(db),
		inviteCodes: await listInviteCodes(db),
		published: await listPublications(db, 50),
		backupsConfigured: (await effectiveBackupConfig(db)) !== null,
		backupStorage: await backupStorageView(db),
		backupRuns: await listRecentBackupRuns(db, 5),
		assetStorage: await assetStorageView(db),
		assetMigrationPending: (await assetMigrationSource(db)) !== null,
		assetMigration: await assetMigrationResult(db),
		// Only the sections that show them pay for these.
		plans: section === 'plans' || section === 'usage' ? await listPlans(db) : [],
		// The accounts table pages through ?page=N (zero-based) and searches ?q=.
		usage:
			section === 'usage'
				? await listAccountUsage(db, {
						query: url.searchParams.get('q') ?? '',
						page: Number(url.searchParams.get('page')) || 0
					})
				: null,
		smtp: await smtpView(db),
		egress: await egressPolicy(db),
		externalAccess: await mcpInstanceEnabled(db),
		secretsAvailable: secretsAvailable()
	};
};

// The S3 fields shared by the backup and asset storage forms.
function s3Input(data: FormData) {
	return {
		endpoint: formText(data, 'endpoint'),
		region: formText(data, 'region'),
		bucket: formText(data, 'bucket'),
		prefix: formText(data, 'prefix'),
		accessKeyId: formText(data, 'accessKeyId'),
		secretAccessKey: formText(data, 'secretAccessKey')
	};
}

// Reads a user id from the form and runs the action, returning a uniform
// result for the page. Keeps the per-action handlers to one line each.
async function onUser(request: Request, scope: string, run: (userId: string) => Promise<boolean>) {
	const data = await request.formData();
	const userId = formText(data, 'userId');
	if (!isUuid(userId) || !(await run(userId))) {
		return fail(400, { scope, message: 'That account could not be updated.' });
	}
	return { scope, done: true };
}

export const actions: Actions = {
	approve: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => approveUser(db, id));
	},
	confirmEmail: async ({ request, locals }) => {
		requireAdmin(locals);
		// Frees an account stuck behind a verification mail that never arrived.
		return onUser(request, 'accounts', (id) => confirmUserEmail(db, id));
	},
	reject: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => rejectUser(db, id));
	},
	enableArchive: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => setUserArchive(db, id, true));
	},
	disableArchive: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => setUserArchive(db, id, false));
	},
	setRole: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const userId = formText(data, 'userId');
		const role = formText(data, 'role');
		if (role !== 'moderator' && role !== 'user') {
			return fail(400, { scope: 'accounts', message: 'Pick a role.' });
		}
		if (!isUuid(userId) || userId === locals.user!.id || !(await setUserRole(db, userId, role))) {
			return fail(400, { scope: 'accounts', message: 'That account could not be updated.' });
		}
		return { scope: 'accounts', done: true };
	},
	suspend: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => setUserSuspended(db, id, true));
	},
	deleteAccount: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const userId = formText(data, 'userId');
		if (!isUuid(userId)) {
			return fail(400, { scope: 'accounts', message: 'That account could not be deleted.' });
		}
		// Never delete an admin or yourself from here.
		const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
		if (!target || target.role === 'admin' || userId === locals.user!.id) {
			return fail(400, { scope: 'accounts', message: 'That account cannot be deleted here.' });
		}
		const config = await effectiveAssetConfig(db);
		await purgeAccount(db, userId, config ? s3AssetStore(config) : null);
		return { scope: 'accounts', done: true };
	},
	unsuspend: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => setUserSuspended(db, id, false));
	},
	cancelDeletion: async ({ request, locals }) => {
		requireAdmin(locals);
		// Rescue an account from a pending self-deletion. Clears only the
		// schedule; a suspension stays its own decision.
		return onUser(request, 'accounts', (id) => adminCancelDeletion(db, id));
	},
	resetTotp: async ({ request, locals }) => {
		requireAdmin(locals);
		// Lockout recovery: clear a user's two-factor so they can sign in with
		// their password alone and set it up again.
		return onUser(request, 'accounts', async (id) => {
			await disableTotp(db, id);
			return true;
		});
	},
	saveSignup: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const mode = formText(data, 'mode');
		if (!SIGNUP_MODES.includes(mode as SignupMode)) {
			return fail(400, { scope: 'signup', message: 'Pick one of the sign-up options.' });
		}
		await saveSignupMode(db, mode as SignupMode);
		return { scope: 'signup', saved: true };
	},
	saveInstanceType: async ({ request, locals }) => {
		requireAdmin(locals);
		const type = formText(await request.formData(), 'type');
		if (!INSTANCE_TYPES.includes(type as InstanceType)) {
			return fail(400, { scope: 'instance-type', message: 'Pick one of the options.' });
		}
		await saveInstanceType(db, type as InstanceType);
		return { scope: 'instance-type', saved: true };
	},
	createInvite: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const maxUses = Number(data.get('maxUses') ?? 1);
		// Blank means the code never expires.
		const expiresRaw = formText(data, 'expiresDays').trim();
		const expiresDays = expiresRaw === '' ? 0 : Number(expiresRaw);
		if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
			return fail(400, {
				scope: 'invites',
				message: 'Uses must be a whole number from 1 to 1000.'
			});
		}
		if (!Number.isInteger(expiresDays) || expiresDays < 0 || expiresDays > 365) {
			return fail(400, {
				scope: 'invites',
				message: 'Leave expiry blank for a code that never expires, or use 1 to 365 days.'
			});
		}
		await createInviteCode(db, {
			createdBy: locals.user!.id,
			label: formText(data, 'label'),
			maxUses,
			expiresAt: expiresDays > 0 ? new Date(Date.now() + expiresDays * 86_400_000) : null
		});
		return { scope: 'invites', done: true };
	},
	deleteInvite: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const inviteId = formText(data, 'inviteId');
		if (!isUuid(inviteId) || !(await deleteInviteCode(db, inviteId))) {
			return fail(400, { scope: 'invites', message: 'That invite code does not exist.' });
		}
		return { scope: 'invites', done: true };
	},
	// How many invite codes a user may generate for friends from their
	// account page.
	setInviteAllowance: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const userId = formText(data, 'userId');
		const allowance = Number(data.get('allowance') ?? 0);
		if (!Number.isInteger(allowance) || allowance < 0 || allowance > 99) {
			return fail(400, {
				scope: 'accounts',
				message: 'Invites must be a whole number from 0 to 99.'
			});
		}
		if (!isUuid(userId) || !(await setInviteAllowance(db, userId, allowance))) {
			return fail(400, { scope: 'accounts', message: 'That account does not exist.' });
		}
		return { scope: 'accounts', done: true };
	},

	runBackup: async ({ locals }) => {
		requireAdmin(locals);
		if (!(await effectiveBackupConfig(db))) {
			return fail(400, { scope: 'backups', message: 'Backups are not configured.' });
		}
		if (!(await queueBackup())) {
			return fail(500, { scope: 'backups', message: 'Could not queue the backup.' });
		}
		return { scope: 'backups', done: true };
	},
	saveBackups: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const result = await saveBackupStorage(db, {
			...s3Input(data),
			keepRecentHours: Number(data.get('keepRecentHours') ?? 48),
			keepDays: Number(data.get('keepDays') ?? 30)
		});
		if (!result.ok) return fail(400, { scope: 'backups', message: result.reason });
		// Make sure the worker's schedule exists without waiting for a restart.
		await applyBackupSchedule((await effectiveBackupConfig(db))?.cron ?? null);
		return { scope: 'backups', saved: true };
	},
	testBackups: async ({ locals }) => {
		requireAdmin(locals);
		const config = await effectiveBackupConfig(db);
		if (!config) {
			return fail(400, { scope: 'backups', message: 'Save the backup settings first.' });
		}
		const probe = await probeS3(config);
		if (!probe.ok) {
			return fail(400, {
				scope: 'backups',
				message: `Could not reach the bucket: ${probe.reason}`
			});
		}
		return { scope: 'backups', tested: true };
	},
	saveAssets: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const result = await saveAssetStorage(db, s3Input(data));
		if (!result.ok) return fail(400, { scope: 'storage', message: result.reason });
		return { scope: 'storage', saved: true };
	},
	testAssets: async ({ locals }) => {
		requireAdmin(locals);
		const config = await effectiveAssetConfig(db);
		if (!config) {
			return fail(400, { scope: 'storage', message: 'Save the asset storage settings first.' });
		}
		const probe = await probeS3(config);
		if (!probe.ok) {
			return fail(400, {
				scope: 'storage',
				message: `Could not reach the bucket: ${probe.reason}`
			});
		}
		return { scope: 'storage', tested: true };
	},
	migrateAssets: async ({ locals }) => {
		requireAdmin(locals);
		if (!(await assetMigrationSource(db))) {
			return fail(400, { scope: 'storage', message: 'There is nothing to copy.' });
		}
		if (!(await queueAssetMigration())) {
			return fail(500, { scope: 'storage', message: 'Could not queue the copy.' });
		}
		return { scope: 'storage', migrating: true };
	},
	dismissMigration: async ({ locals }) => {
		requireAdmin(locals);
		await clearAssetMigrationSource(db);
		return { scope: 'storage', done: true };
	},
	createPlan: async ({ request, locals }) => {
		requireAdmin(locals);
		const result = await createPlan(db, formText(await request.formData(), 'name'));
		if (!result.ok) return fail(400, { scope: 'plans', message: result.reason });
		return { scope: 'plans', done: true };
	},
	savePlan: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const planId = formText(data, 'planId');
		const universes = parseLimitInput(formText(data, 'maxUniverses'), MAX_COUNT_LIMIT);
		const stories = parseLimitInput(formText(data, 'maxStories'), MAX_COUNT_LIMIT);
		const storageBytes = parseMegabytesField(
			formText(data, 'storageMb'),
			formText(data, 'storageBytes'),
			MAX_STORAGE_MB
		);
		// 0 would refuse every image, so the smallest size is 0.1 MB.
		const parsedImageBytes = parseMegabytesField(
			formText(data, 'maxImageMb'),
			formText(data, 'maxImageBytes'),
			MAX_IMAGE_BYTES / MEGABYTE
		);
		const imageBytes = parsedImageBytes === 0 ? undefined : parsedImageBytes;
		if (universes === undefined || stories === undefined) {
			return fail(400, {
				scope: 'plans',
				planId,
				message: `Limits are whole numbers from 0 to ${MAX_COUNT_LIMIT}, or blank for no limit.`
			});
		}
		if (storageBytes === undefined) {
			return fail(400, {
				scope: 'plans',
				planId,
				message: `Storage is a number of MB from 0 to ${MAX_STORAGE_MB}, with at most one decimal place, or blank for no limit.`
			});
		}
		if (imageBytes === undefined) {
			return fail(400, {
				scope: 'plans',
				planId,
				message: `The largest image is a number of MB from 0.1 to ${MAX_IMAGE_BYTES / MEGABYTE}, with at most one decimal place, or blank for ${MAX_IMAGE_BYTES / MEGABYTE} MB, the most any plan allows.`
			});
		}
		if (!isUuid(planId)) {
			return fail(400, { scope: 'plans', message: 'That plan does not exist.' });
		}
		const result = await savePlan(db, planId, {
			name: formText(data, 'name'),
			limits: {
				max_universes: universes,
				max_stories: stories,
				storage_bytes: storageBytes,
				max_image_bytes: imageBytes
			}
		});
		if (!result.ok) return fail(400, { scope: 'plans', planId, message: result.reason });
		return { scope: 'plans', planId, saved: true };
	},
	setDefaultPlan: async ({ request, locals }) => {
		requireAdmin(locals);
		const planId = formText(await request.formData(), 'planId');
		if (!isUuid(planId) || !(await setDefaultPlan(db, planId))) {
			return fail(400, { scope: 'plans', message: 'That plan does not exist.' });
		}
		return { scope: 'plans', done: true };
	},
	// Blank plan id puts the account back on the default plan.
	setUserPlan: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const userId = formText(data, 'userId');
		const planId = formText(data, 'planId');
		if (
			!isUuid(userId) ||
			(planId !== '' && !isUuid(planId)) ||
			!(await setUserPlan(db, userId, planId || null))
		) {
			return fail(400, { scope: 'usage', message: 'That account could not be updated.' });
		}
		return { scope: 'usage', done: true };
	},
	// One batch of accounts per request; the page posts again with next until
	// it is null. done carries the running total.
	recountStorage: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const after = formText(data, 'after');
		const done = Math.max(0, Math.floor(Number(formText(data, 'done')) || 0));
		if (after !== '' && !isUuid(after)) {
			return fail(400, {
				scope: 'usage',
				message: 'The recount could not continue. Start it again.'
			});
		}
		const batch = await recountStorageBatch(db, after || null);
		return { scope: 'usage', recounted: done + batch.recounted, next: batch.next };
	},
	saveSmtp: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const result = await saveSmtp(db, {
			host: formText(data, 'host'),
			port: Number(data.get('port') ?? 587),
			secure: data.get('secure') === 'on',
			user: formText(data, 'user'),
			from: formText(data, 'from'),
			password: formText(data, 'password')
		});
		if (!result.ok) return fail(400, { scope: 'smtp', message: result.reason });
		return { scope: 'smtp', saved: true };
	},
	testEmail: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const to = formText(data, 'testTo').trim() || locals.user!.email;
		if (!EMAIL_RE.test(to)) {
			return fail(400, { scope: 'smtp', message: 'Enter a valid address to send the test to.' });
		}
		// Sent inline (not queued) so the result is reported back to the admin.
		try {
			await sendEmail(db, {
				to,
				subject: 'Codex test email',
				text: 'This is a test email from your Codex instance. Email is working.'
			});
		} catch (err) {
			const detail = err instanceof Error ? err.message : 'unknown error';
			// A missing greeting or a TLS handshake error almost always means
			// the TLS toggle does not match what the relay expects.
			const tlsHint = /greeting never received|wrong version number|ssl|tls/i.test(detail)
				? ' This usually means the TLS setting does not match the relay: turn "Use TLS on connect" on if the relay wants TLS from the start, off if it wants STARTTLS.'
				: '';
			return fail(400, {
				scope: 'smtp',
				message: `Could not send: ${detail}${tlsHint}`
			});
		}
		return { scope: 'smtp', tested: true, testTo: to };
	},
	saveEgress: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const policy = formText(data, 'policy');
		if (policy !== 'block-private' && policy !== 'allowlist' && policy !== 'open') {
			return fail(400, { scope: 'egress', message: 'Pick an egress policy.' });
		}
		// One host per line in the textarea; saveEgressPolicy trims, lowercases,
		// and de-duplicates, and refuses an allowlist policy with no hosts.
		const allowlist = formText(data, 'allowlist')
			.split('\n')
			.map((host) => host.trim())
			.filter(Boolean);
		const result = await saveEgressPolicy(db, { policy: policy as EgressPolicyName, allowlist });
		if (!result.ok) return fail(400, { scope: 'egress', message: result.reason });
		return { scope: 'egress', saved: true };
	},
	// The instance switch for outside apps (the MCP endpoint and its sign-in).
	saveExternalAccess: async ({ request, locals }) => {
		requireAdmin(locals);
		const enabled = formText(await request.formData(), 'enabled') === 'on';
		await saveMcpInstanceEnabled(db, enabled);
		logEvent('info', 'admin.external_access', { adminId: locals.user!.id, enabled });
		return { scope: 'external-access', saved: true };
	}
};
