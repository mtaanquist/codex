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
