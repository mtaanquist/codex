import { expect, test } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu } from './library';

// Runs as the account with the Assistant switched on, so the section shows.
test.use({ storageState: 'e2e/.auth/assistant.json' });

async function query(text: string, values: unknown[] = []) {
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		return await pool.query(text, values);
	} finally {
		await pool.end();
	}
}

// A content limit saves when it is picked, and saving another setting later
// leaves it as it is.
test('a content limit is kept when another preference saves', async ({ page }) => {
	const slug = `e2e-limit-${Date.now()}`;
	const name = `E2E limit ${Date.now()}`;
	await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [name, slug]);
	try {
		await gotoReady(page, '/');
		await pickFromLibraryMenu(page, 'New universe');
		await page.getByLabel('New universe').fill(`Limits ${Date.now()}`);
		await page.getByRole('button', { name: 'Create universe' }).click();
		await expect(page.locator('#u-name')).toBeVisible();
		await gotoReady(page, `${new URL(page.url()).pathname}/preferences`);

		const limit = page.getByRole('combobox', { name });
		await limit.selectOption('avoid');
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
		await page.getByRole('combobox', { name: 'Tense' }).selectOption('present');
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('avoid');
		await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('present');

		// Clearing it again is saved too.
		await page.getByRole('combobox', { name }).selectOption('');
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
	} finally {
		await query(`delete from tags where slug = $1 and kind = 'warning'`, [slug]);
	}
});

async function openUniversePreferences(page: import('@playwright/test').Page) {
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Limits ${Date.now()}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.locator('#u-name')).toBeVisible();
	await gotoReady(page, `${new URL(page.url()).pathname}/preferences`);
}

// A limit picked after the warning list changed under the open page is not
// stored, and the select goes back to what is stored instead of keeping the
// pick on show.
test('a limit not stored because the list changed shows what is stored', async ({ page }) => {
	const stamp = Date.now();
	const slug = `e2e-stale-${stamp}`;
	const name = `E2E stale ${stamp}`;
	const added = `e2e-added-${stamp}`;
	await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [name, slug]);
	try {
		await openUniversePreferences(page);
		await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [
			`E2E added ${stamp}`,
			added
		]);
		const limit = page.getByRole('combobox', { name });
		await limit.selectOption('avoid');
		await expect(
			page.getByRole('status').filter({ hasText: 'your content limits were not changed' })
		).toBeVisible();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');

		// Another save says Saved and still shows the stored limit.
		await page.getByRole('combobox', { name: 'Tense' }).selectOption('present');
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await page.getByRole('combobox', { name: 'Tense' }).selectOption('past');
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('past');
	} finally {
		await query(`delete from tags where slug = any($1) and kind = 'warning'`, [[slug, added]]);
	}
});

// Two quick picks save one after the other, so the last one is what is stored
// even when the first save is slow to land.
test('the last of two quick limit picks is the one stored', async ({ page }) => {
	const slug = `e2e-quick-${Date.now()}`;
	const name = `E2E quick ${Date.now()}`;
	await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [name, slug]);
	try {
		await openUniversePreferences(page);
		let first = true;
		await page.route(
			(url) => url.search.includes('saveAssistantPreferences'),
			async (route) => {
				if (first) {
					first = false;
					await new Promise((resolve) => setTimeout(resolve, 800));
				}
				await route.continue();
			}
		);
		const limit = page.getByRole('combobox', { name });
		await limit.selectOption('write');
		await limit.selectOption('avoid');
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
		await expect(limit).toHaveValue('avoid');
		await page.unrouteAll({ behavior: 'wait' });
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('avoid');
	} finally {
		await query(`delete from tags where slug = $1 and kind = 'warning'`, [slug]);
	}
});

// A limit picked after the warning list changed, with another change queued
// behind its slow save, is not stored, and the writer is told so instead of
// seeing "Saved." while the pick quietly goes away.
test('a limit not stored with a change queued behind it still says why', async ({ page }) => {
	const stamp = Date.now();
	const slug = `e2e-queued-${stamp}`;
	const name = `E2E queued ${stamp}`;
	const added = `e2e-queued-added-${stamp}`;
	await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [name, slug]);
	try {
		await openUniversePreferences(page);
		await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [
			`E2E queued added ${stamp}`,
			added
		]);
		let first = true;
		await page.route(
			(url) => url.search.includes('saveAssistantPreferences'),
			async (route) => {
				if (first) {
					first = false;
					await new Promise((resolve) => setTimeout(resolve, 800));
				}
				await route.continue();
			}
		);
		await page.getByRole('combobox', { name }).selectOption('avoid');
		await page.getByRole('combobox', { name: 'Tense' }).selectOption('present');
		await expect(
			page.getByRole('status').filter({ hasText: 'your content limits were not changed' })
		).toBeVisible();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('present');
		await page.unrouteAll({ behavior: 'wait' });
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('present');
	} finally {
		await query(`delete from tags where slug = any($1) and kind = 'warning'`, [[slug, added]]);
	}
});
