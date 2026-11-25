import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { violations } from './axe';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// Runs as the account with the Assistant switched on, so the section shows.
test.use({ storageState: 'e2e/.auth/assistant.json' });

// #1548: Assistant preferences is its own settings item, not part of Details.
test('Assistant preferences has its own settings page for a universe and a story', async ({
	page
}) => {
	await gotoReady(page, '/');
	const name = `Prefs ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(name);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${name} - settings`);
	const universeUrl = new URL(page.url()).pathname;

	// Details no longer holds the form.
	await expect(page.locator('#u-name')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Assistant preferences' })).toHaveCount(0);

	await page
		.getByRole('navigation', { name: 'Universe settings' })
		.getByRole('link', { name: 'Assistant preferences' })
		.click();
	await expect(page).toHaveURL(`${universeUrl}/preferences`);
	await expect(
		page.getByRole('heading', { name: 'Assistant preferences', level: 2 })
	).toBeVisible();
	await expect(page.locator('#u-name')).toBeHidden();
	await page.getByRole('combobox', { name: 'Tense' }).selectOption('present');
	await page.getByRole('button', { name: 'Save preferences' }).click();
	// A plain form post stays on the section's page.
	await expect(page).toHaveURL(new RegExp(`${universeUrl}/preferences\\?`));
	await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
	await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('present');
	expect(await violations(page)).toEqual([]);

	// A story in the universe shows the universe's choice as its default.
	await gotoReady(page, '/');
	await startStoryInUniverse(page, name);
	await page.getByLabel('New story').fill('Prefs story');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Prefs story');
	const slug = new URL(page.url()).pathname.split('/')[2];

	await gotoReady(page, `/stories/${slug}/settings`);
	await expect(page.locator('#st-title')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Assistant preferences' })).toHaveCount(0);
	await page
		.getByRole('navigation', { name: 'Story settings' })
		.getByRole('link', { name: 'Assistant preferences' })
		.click();
	await expect(page).toHaveURL(`/stories/${slug}/settings/preferences`);
	const tense = page.getByRole('combobox', { name: 'Tense' });
	await expect(tense.locator('option').first()).toHaveText(/: Present$/);
	await tense.selectOption('past');
	await page.getByRole('button', { name: 'Save preferences' }).click();
	await expect(page).toHaveURL(new RegExp(`/stories/${slug}/settings/preferences\\?`));
	await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
	await page.reload();
	await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('past');
	expect(await violations(page)).toEqual([]);
});
