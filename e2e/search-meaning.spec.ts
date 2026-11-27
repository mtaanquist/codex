import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// #1787: the command palette's "By meaning" mode. It is hidden while the
// universe has no search index; with one, typing sends nothing and Enter runs
// one search. The index and the search are stubbed, so no embeddings model is
// needed; the endpoint's own rules are covered by the integration tests.
test('the palette searches by meaning only where there is an index, and only on Enter', async ({
	page
}) => {
	await gotoReady(page, '/');
	const universeName = `Meaning ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	await gotoReady(page, '/');
	await startStoryInUniverse(page, universeName);
	await page.getByLabel('New story').fill('Tides');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Tides');
	const storyPath = new URL(page.url()).pathname;

	// No index: the palette shows no mode switch.
	const checked = page.waitForResponse((r) => r.url().includes('/api/search/meaning'));
	const opener = page.getByRole('button', { name: /Search and commands/ });
	await opener.click();
	await checked;
	await expect(page.getByLabel('Search everything')).toBeVisible();
	await expect(page.getByRole('group', { name: 'Search by' })).toHaveCount(0);
	await page.keyboard.press('Escape');

	const searches: string[] = [];
	await page.route('**/api/search/meaning*', async (route) => {
		const request = route.request();
		if (request.method() === 'GET') {
			await route.fulfill({ json: { universeId: '00000000-0000-4000-8000-000000000001' } });
			return;
		}
		searches.push((request.postDataJSON() as { query: string }).query);
		await route.fulfill({
			json: {
				results: [
					{
						sceneId: '00000000-0000-4000-8000-000000000002',
						sceneTitle: 'The harbour',
						storyTitle: 'Tides',
						passage: 'She told the guard her brother had been with her all night.',
						href: `${storyPath}?scene=00000000-0000-4000-8000-000000000002`
					}
				]
			}
		});
	});

	await opener.click();
	const modes = page.getByRole('group', { name: 'Search by' });
	await expect(modes.getByRole('button', { name: 'Words' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await modes.getByRole('button', { name: 'Meaning' }).click();
	const box = page.getByLabel('Search by meaning');
	await expect(box).toBeFocused();
	await box.fill('someone lies to protect a friend');
	await expect(page.getByText('to search')).toBeVisible();
	// Typing sends nothing; Enter sends one search.
	await page.waitForTimeout(400);
	expect(searches).toEqual([]);
	await page.keyboard.press('Enter');
	const result = page.getByRole('option', { name: /Scene The harbour Tides/ });
	await expect(result).toBeVisible();
	await expect(result).toContainText('her brother had been with her all night');
	expect(searches).toEqual(['someone lies to protect a friend']);

	// Back to words: the commands return.
	await modes.getByRole('button', { name: 'Words' }).click();
	await page.getByLabel('Search everything').fill('new scene');
	await expect(page.getByRole('option', { name: 'Command New scene' })).toBeVisible();

	// A result opens its scene.
	await modes.getByRole('button', { name: 'Meaning' }).click();
	await page.getByLabel('Search by meaning').fill('a lie');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('option', { name: /Scene The harbour/ })).toBeVisible();
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/scene=00000000-0000-4000-8000-000000000002/);
	await expect(page.getByLabel('Search by meaning')).toHaveCount(0);
});
