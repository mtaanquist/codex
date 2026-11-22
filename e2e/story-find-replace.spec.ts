import { expect, test, type Page } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';
import { openRowMenu } from './context-menu';
import { confirmPrompt } from './confirm';

// Find and replace across a chapter (#1302): every match is listed before
// anything changes, an unticked match stays, and the change survives a reload
// with a History entry on the scene.

async function typeScene(page: Page, text: string) {
	await page.locator('.cm-content').click();
	const save = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.ok()
	);
	await page.keyboard.type(text);
	await save;
}

test('find and replace across a chapter, with a per-match choice', async ({ page }) => {
	await gotoReady(page, '/');
	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Replacefall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Replacefall ${stamp}`);
	await page.getByLabel('New story').fill(`Villages ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();

	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await typeScene(page, 'The city slept. A city woke.');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page.locator('.cm-content')).not.toContainText('slept');
	await typeScene(page, 'The city burned.');

	// The find panel widens the search to the chapter.
	await page.keyboard.press('ControlOrMeta+f');
	const panel = page.locator('.cm-panel.cm-search');
	await panel.getByRole('textbox', { name: 'Find', exact: true }).fill('city');
	await page.locator('.cm-search-scope').getByRole('button', { name: 'This chapter...' }).click();

	const dialog = page.getByRole('dialog', { name: 'Find and replace' });
	await expect(dialog.getByRole('status').first()).toContainText('3 matches in 2 scenes');
	await dialog.getByLabel('Replace with').fill('village');
	// Untick the second match of the first scene.
	const firstScene = dialog.locator('.fr-scene').first();
	await firstScene.locator('.fr-match').nth(1).getByRole('checkbox').uncheck();
	await dialog.getByRole('button', { name: 'Replace 2 matches' }).click();
	await expect(dialog).toContainText('Replaced 2 matches in 2 scenes');
	await dialog.getByRole('button', { name: 'Done' }).click();
	await expect(dialog).toHaveCount(0);

	// The open scene shows the new text at once, and it is stored.
	await expect(page.locator('.cm-content')).toContainText('The village burned.');
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('The village burned.');
	await page.getByRole('tab', { name: 'History' }).click();
	await expect(page.getByText('Replaced "city" with "village"')).toBeVisible();

	// The first scene kept the unticked match.
	await page.locator('.scene-row', { hasText: 'Untitled scene' }).first().click();
	await expect(page.locator('.cm-content')).toContainText('The village slept. A city woke.');
});

// #1312: moving the open scene into a chapter while the find panel is open
// shows the chapter button without closing and reopening the panel.
test('the find panel follows the scene into a chapter', async ({ page }) => {
	await gotoReady(page, '/');
	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Movefall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Movefall ${stamp}`);
	await page.getByLabel('New story').fill(`Drifters ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();

	// An unfiled scene: write it in a chapter, then delete the chapter.
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await typeScene(page, 'A drifting scene.');
	await (
		await openRowMenu(page, page.locator('.chapter-row').first())
	)
		.getByRole('menuitem', { name: 'Delete chapter' })
		.click();
	await confirmPrompt(page, 'Delete chapter');
	await expect(page.locator('.unfiled-head .chapter-name')).toHaveText('Unfiled scenes');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('button.chapter-row')).toHaveCount(1);

	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+f');
	const scope = page.locator('.cm-search-scope');
	await expect(scope.getByRole('button', { name: 'Whole story...' })).toBeVisible();
	await expect(scope.getByRole('button', { name: 'This chapter...' })).toHaveCount(0);

	const orderSave = page.waitForResponse((r) => r.url().includes('/scene-order') && r.ok());
	await page.locator('.scene-row').first().dragTo(page.locator('button.chapter-row').first());
	await orderSave;
	await expect(page.locator('.unfiled-head')).toHaveCount(0);
	await expect(page.locator('.cm-content')).toContainText('A drifting scene.');
	await expect(scope.getByRole('button', { name: 'This chapter...' })).toBeVisible();
});
