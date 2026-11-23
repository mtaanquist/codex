import { expect, test, type Page } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// Ctrl/Cmd+Alt+M while the scene was changed in another window: the server
// holds text this editor has not seen, so a marker would count into the wrong
// words. Nothing is marked until the writer picks a version.

async function newStory(page: Page, name: string) {
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`${name}vale`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(/\/universes\//);
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `${name}vale`);
	await page.getByLabel('New story').fill(`${name} Book`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(/\/stories\//);
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
}

const saved = (page: Page) =>
	page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.ok()
	);

test('a marker is not made while the scene was changed in another window', async ({ page }) => {
	test.slow();
	await newStory(page, `Ferry ${Date.now()}`);
	const editor = page.getByRole('textbox', { name: 'Scene text' });
	let landed = saved(page);
	await editor.click();
	await page.keyboard.type('The ferry left at dawn.');
	await landed;

	const other = await page.context().newPage();
	await gotoReady(other, page.url());
	const otherEditor = other.getByRole('textbox', { name: 'Scene text' });
	await expect(otherEditor).toContainText('The ferry left at dawn.');
	landed = saved(other);
	await otherEditor.click();
	await other.keyboard.press('ControlOrMeta+Home');
	await other.keyboard.type('Rain. ');
	await landed;
	await other.close();

	const refused = page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.status() === 409
	);
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(' It was late.');
	await refused;
	await expect(page.getByText('This scene was changed in another window').first()).toBeVisible();

	const posts: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes('/markers') && request.method() === 'POST')
			posts.push(request.url());
	});
	for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
	await page.keyboard.press('ControlOrMeta+Alt+m');
	await expect(
		page.getByText('Choose which version to keep, then mark the words again.')
	).toBeVisible();
	expect(posts).toEqual([]);
	await expect(page.locator('.todo-marker')).toHaveCount(0);

	// Once the newer text is loaded, marking works again.
	await page.getByRole('button', { name: 'Load newer version' }).click();
	await expect(editor).toContainText('Rain. The ferry left at dawn.');
	const created = page.waitForResponse(
		(r) => r.url().includes('/markers') && r.request().method() === 'POST' && r.ok()
	);
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
	await page.keyboard.press('ControlOrMeta+Alt+m');
	await created;
	await expect(page.locator('.todo-marker')).toHaveText(['dawn.']);
});

// The same, when this window has no edits of its own to save: there is
// nothing here to lose, so the newer text is shown and the writer marks again.
// Nothing is saved over the other window's text.
test('a marker made over text changed in another window loads the newer text', async ({ page }) => {
	test.slow();
	await newStory(page, `Ford ${Date.now()}`);
	const editor = page.getByRole('textbox', { name: 'Scene text' });
	const landed = saved(page);
	await editor.click();
	await page.keyboard.type('The ford ran high.');
	await landed;

	const other = await page.context().newPage();
	await gotoReady(other, page.url());
	const otherEditor = other.getByRole('textbox', { name: 'Scene text' });
	await expect(otherEditor).toContainText('The ford ran high.');
	const otherLanded = saved(other);
	await otherEditor.click();
	await other.keyboard.press('ControlOrMeta+Home');
	await other.keyboard.type('Snow. ');
	await otherLanded;
	await other.close();

	const refusedSaves: string[] = [];
	page.on('response', (response) => {
		if (
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.status() === 409
		)
			refusedSaves.push(response.url());
	});
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
	await page.keyboard.press('ControlOrMeta+Alt+m');
	await expect(page.getByText('now shows the newer version')).toBeVisible();
	await expect(editor).toHaveText('Snow. The ford ran high.');
	await expect(page.getByRole('button', { name: 'Load newer version' })).toHaveCount(0);
	await expect(page.locator('.todo-marker')).toHaveCount(0);

	const created = page.waitForResponse(
		(r) => r.url().includes('/markers') && r.request().method() === 'POST' && r.ok()
	);
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
	await page.keyboard.press('ControlOrMeta+Alt+m');
	await created;
	await expect(page.locator('.todo-marker')).toHaveText(['high.']);
	expect(refusedSaves).toEqual([]);

	// The other window's text is what the server keeps.
	await page.reload();
	await expect(page.getByRole('textbox', { name: 'Scene text' })).toHaveText(
		'Snow. The ford ran high.'
	);
});

// Undo after the newer text loads must not bring the older text back, or the
// next autosave would store it over the other window's words.
test('undo after the newer text loads keeps the other window words', async ({ page }) => {
	test.slow();
	await newStory(page, `Shoal ${Date.now()}`);
	const editor = page.getByRole('textbox', { name: 'Scene text' });
	const landed = saved(page);
	await editor.click();
	await page.keyboard.type('The shoal lay bare.');
	await landed;

	const other = await page.context().newPage();
	await gotoReady(other, page.url());
	const otherEditor = other.getByRole('textbox', { name: 'Scene text' });
	await expect(otherEditor).toContainText('The shoal lay bare.');
	const otherLanded = saved(other);
	await otherEditor.click();
	await other.keyboard.press('ControlOrMeta+Home');
	await other.keyboard.type('Ebb. ');
	await otherLanded;
	await other.close();

	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
	await page.keyboard.press('ControlOrMeta+Alt+m');
	await expect(page.getByText('now shows the newer version')).toBeVisible();
	await expect(editor).toHaveText('Ebb. The shoal lay bare.');

	// Undo takes back this window's own typing, not the loaded text.
	const undoSaved = saved(page);
	await page.keyboard.press('ControlOrMeta+z');
	await expect(editor).toContainText('Ebb.');
	await expect(editor).not.toContainText('bare.');
	await undoSaved;
	const redoSaved = saved(page);
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await expect(editor).toHaveText('Ebb. The shoal lay bare.');
	await redoSaved;

	// Markers work as usual afterwards.
	const created = page.waitForResponse(
		(r) => r.url().includes('/markers') && r.request().method() === 'POST' && r.ok()
	);
	await page.keyboard.press('ControlOrMeta+End');
	for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
	await page.keyboard.press('ControlOrMeta+Alt+m');
	await created;
	await expect(page.locator('.todo-marker')).toHaveText(['bare.']);

	await page.reload();
	await expect(page.getByRole('textbox', { name: 'Scene text' })).toHaveText(
		'Ebb. The shoal lay bare.'
	);
	await expect(page.locator('.todo-marker')).toHaveText(['bare.']);
});

// Keep mine settles the conflict, so the message about it goes too.
test('keeping this version clears the marker message', async ({ page }) => {
	test.slow();
	await newStory(page, `Weir ${Date.now()}`);
	const editor = page.getByRole('textbox', { name: 'Scene text' });
	let landed = saved(page);
	await editor.click();
	await page.keyboard.type('The weir held.');
	await landed;

	const other = await page.context().newPage();
	await gotoReady(other, page.url());
	const otherEditor = other.getByRole('textbox', { name: 'Scene text' });
	await expect(otherEditor).toContainText('The weir held.');
	landed = saved(other);
	await otherEditor.click();
	await other.keyboard.press('ControlOrMeta+Home');
	await other.keyboard.type('Mist. ');
	await landed;
	await other.close();

	const refused = page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.status() === 409
	);
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(' Barely.');
	await refused;
	for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
	await page.keyboard.press('ControlOrMeta+Alt+m');
	const message = page.getByText('Choose which version to keep, then mark the words again.');
	await expect(message).toBeVisible();

	await page.getByRole('button', { name: 'Keep mine' }).click();
	await expect(message).toHaveCount(0);
});
