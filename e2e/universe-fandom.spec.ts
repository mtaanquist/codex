import { expect, test } from '@playwright/test';
import pg from 'pg';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu } from './library';
import { e2eDatabaseUrl } from './database';

// Picking a known setting while naming a new universe links the two, and the
// universe settings show the link.
test('a new universe can be set in a known setting from the list', async ({ page }) => {
	const stamp = Date.now();
	const setting = `Ringworld ${stamp}`;
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		await pool.query(`insert into tags (kind, name, slug) values ('fandom', $1, $2)`, [
			setting,
			`ringworld-${stamp}`
		]);
	} finally {
		await pool.end();
	}

	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Ringwor`);
	const option = page.getByRole('option', { name: setting });
	await expect(option).toBeVisible();
	await page.getByLabel('New universe').press('ArrowDown');
	await option.click();
	await expect(page.getByLabel('New universe')).toHaveValue(setting);
	await expect(page.getByText(`Set in ${setting}`)).toBeVisible();
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(`/universes/ringworld-${stamp}`);

	await expect(page.locator('.fandom-linked')).toContainText(setting);
	await expect(page.getByLabel('Established setting')).toBeChecked();

	// Unlinking saves on its own, though the picker changes a hidden field.
	await page.getByRole('button', { name: 'Unlink' }).click();
	// The fandom box keeps its own (empty) status region for its match count.
	await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
	await page.reload();
	await expect(page.locator('.fandom-linked')).toHaveCount(0);
});
