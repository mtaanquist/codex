import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// A refused tag save keeps what the writer picked and typed, so nothing has to
// be entered again; fixing the problem and saving stores it all.
test('a refused tag save keeps the writer choices', async ({ page }) => {
	const stamp = Date.now();
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Tag world ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Tag world ${stamp}`);
	await page.getByLabel('New story').fill(`Tag story ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText(`Tag story ${stamp}`);
	const storyPath = new URL(page.url()).pathname;

	await gotoReady(page, `${storyPath}/settings/publish`);
	await page.getByRole('checkbox', { name: 'Fantasy' }).check();
	await page.getByRole('button', { name: 'Tags', exact: true }).click();
	await page.getByLabel('Add tag').fill('found family');
	await page.getByLabel('Add tag').press('Enter');
	await page.getByRole('button', { name: 'Fandoms', exact: true }).click();
	await page.getByLabel('Add fandom').fill(`Nowhere ${stamp}`);
	await page.getByLabel('Add fandom').press('Enter');
	await page.getByRole('button', { name: 'Save tags' }).click();

	await expect(page.getByRole('alert')).toContainText(`Nowhere ${stamp}`);
	await expect(page.getByRole('checkbox', { name: 'Fantasy' })).toBeChecked();
	await expect(page.getByRole('button', { name: 'Remove found family' })).toBeVisible();

	await page.getByRole('button', { name: `Remove Nowhere ${stamp}` }).click();
	await page.getByRole('button', { name: 'Save tags' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
	await page.reload();
	await expect(page.getByRole('checkbox', { name: 'Fantasy' })).toBeChecked();
	await expect(page.getByRole('button', { name: 'Remove found family' })).toBeVisible();
});
