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

// Another window changes the scene. Undo after the newer text loads here
// must do nothing: replaying this window's older edits onto the other
// window's words would garble them, and the next autosave would store that.
async function changeElsewhere(page: Page, before: string, after: string) {
	const other = await page.context().newPage();
	await gotoReady(other, page.url());
	const otherEditor = other.getByRole('textbox', { name: 'Scene text' });
	await expect(otherEditor).toHaveText(before);
	const otherLanded = saved(other);
	await otherEditor.click();
	await other.keyboard.press('ControlOrMeta+A');
	await other.keyboard.type(after);
	await otherLanded;
	await other.close();
}

test('undo after the newer text loads keeps the other window words', async ({ page }) => {
	test.slow();
	await newStory(page, `Shoal ${Date.now()}`);
	const editor = page.getByRole('textbox', { name: 'Scene text' });
	let landed = saved(page);
	await editor.click();
	await page.keyboard.type('The cat sat on the old mat today.');
	await landed;
	// Delete "old ", which is then saved too.
	landed = saved(page);
	for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
	for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
	await landed;
	await expect(editor).toHaveText('The cat sat on the mat today.');

	await changeElsewhere(page, 'The cat sat on the mat today.', 'The dog sat on the mat yesterday.');

	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
	await page.keyboard.press('ControlOrMeta+Alt+m');
	await expect(page.getByText('now shows the newer version')).toBeVisible();
	await expect(editor).toHaveText('The dog sat on the mat yesterday.');

	await page.keyboard.press('ControlOrMeta+z');
	await page.keyboard.press('ControlOrMeta+z');
	await expect(editor).toHaveText('The dog sat on the mat yesterday.');

	// Markers and undo work as usual afterwards.
	const created = page.waitForResponse(
		(r) => r.url().includes('/markers') && r.request().method() === 'POST' && r.ok()
	);
	await page.keyboard.press('ControlOrMeta+End');
	for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowLeft');
	await page.keyboard.press('ControlOrMeta+Alt+m');
	await created;
	await expect(page.locator('.todo-marker')).toHaveText(['yesterday.']);
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(' Rain.');
	await page.keyboard.press('ControlOrMeta+z');
	await expect(editor).toHaveText('The dog sat on the mat yesterday.');
	landed = saved(page);
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await expect(editor).toHaveText('The dog sat on the mat yesterday. Rain.');
	await landed;

	await page.reload();
	await expect(page.getByRole('textbox', { name: 'Scene text' })).toHaveText(
		'The dog sat on the mat yesterday. Rain.'
	);
	await expect(page.locator('.todo-marker')).toHaveText(['yesterday.']);
});

test('undo after Load newer version keeps the other window words', async ({ page }) => {
	test.slow();
	await newStory(page, `Reef ${Date.now()}`);
	const editor = page.getByRole('textbox', { name: 'Scene text' });
	const landed = saved(page);
	await editor.click();
	await page.keyboard.type('The cat sat on the old mat today.');
	await landed;

	await changeElsewhere(
		page,
		'The cat sat on the old mat today.',
		'The dog sat on the mat yesterday.'
	);

	// An edit here is refused, since the scene changed in the other window.
	const refused = page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.status() === 409
	);
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
	for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
	await refused;
	await page.getByRole('button', { name: 'Load newer version' }).click();
	await expect(editor).toHaveText('The dog sat on the mat yesterday.');

	await editor.click();
	await page.keyboard.press('ControlOrMeta+z');
	await page.keyboard.press('ControlOrMeta+z');
	await expect(editor).toHaveText('The dog sat on the mat yesterday.');

	await page.reload();
	await expect(page.getByRole('textbox', { name: 'Scene text' })).toHaveText(
		'The dog sat on the mat yesterday.'
	);
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

// Two quick marks over text changed in another window: the second loads the
// newer text, and the first, answered after that, must not then ask the
// writer to choose a version when there is nothing to choose.
test('a mark answered after the newer text loads keeps the right message', async ({ page }) => {
	test.slow();
	await newStory(page, `Delta ${Date.now()}`);
	const editor = page.getByRole('textbox', { name: 'Scene text' });
	const landed = saved(page);
	await editor.click();
	await page.keyboard.type('The tide came in.');
	await landed;
	await changeElsewhere(page, 'The tide came in.', 'The tide went out.');

	let posts = 0;
	await page.route('**/api/scenes/*/markers', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		if (++posts === 1) await new Promise((resolve) => setTimeout(resolve, 1500));
		await route.continue();
	});
	let answered = 0;
	page.on('requestfinished', (request) => {
		if (request.url().includes('/markers') && request.method() === 'POST') answered++;
	});
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
	await page.keyboard.press('ControlOrMeta+Alt+m');
	await expect.poll(() => posts).toBe(1);
	await page.keyboard.press('ControlOrMeta+Alt+m');
	await expect(editor).toHaveText('The tide went out.');
	// Both answers are in; give the page a moment to act on the late one.
	await expect.poll(() => answered).toBe(2);
	await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
	await expect(page.getByText('now shows the newer version')).toBeVisible();
	await expect(page.getByText('Choose which version to keep')).toHaveCount(0);
});

async function pasteImage(page: Page, name: string) {
	await page.getByRole('textbox', { name: 'Scene text' }).evaluate((el, fileName) => {
		const data = new DataTransfer();
		data.items.add(new File(['png'], fileName, { type: 'image/png' }));
		el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
	}, name);
}

// While an image uploads the newer text cannot be loaded for the writer, so
// marking keeps failing until the upload is done; the message says to wait.
test('marking during an upload over changed text says to wait for the image', async ({ page }) => {
	test.slow();
	await newStory(page, `Sound ${Date.now()}`);
	const editor = page.getByRole('textbox', { name: 'Scene text' });
	let landed = saved(page);
	await editor.click();
	await page.keyboard.type('The bell rang.');
	await landed;
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/api/assets', async (route) => {
		await held;
		await route.fulfill({ json: { path: '/assets/bell.png' } });
	});
	landed = saved(page);
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.press('Enter');
	await pasteImage(page, 'bell.png');
	await expect(editor).toContainText('Uploading bell.png');
	await landed;
	await changeElsewhere(page, 'The bell rang.', 'The bell was silent.');

	await editor.click();
	await page.keyboard.press('ControlOrMeta+Home');
	for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
	await page.keyboard.press('ControlOrMeta+Alt+m');
	await expect(page.getByText('Wait for the image to finish uploading')).toBeVisible();
	await expect(page.locator('.todo-marker')).toHaveCount(0);
	release();
});

// Loading the newer text clears undo history, so a notice about an image that
// was not added stops suggesting Undo.
test('the lost-image notice stops suggesting Undo once newer text loads', async ({ page }) => {
	test.slow();
	await newStory(page, `Bay ${Date.now()}`);
	const editor = page.getByRole('textbox', { name: 'Scene text' });
	let landed = saved(page);
	await editor.click();
	await page.keyboard.type('The gull flew.');
	await landed;
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/api/assets', async (route) => {
		await held;
		await route.fulfill({ json: { path: '/assets/gull.png' } });
	});
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.press('Enter');
	await pasteImage(page, 'gull.png');
	await expect(editor).toContainText('Uploading gull.png');
	// Remove the "Uploading" line, then let the upload finish.
	landed = saved(page);
	await page.keyboard.press('ControlOrMeta+Home');
	await page.keyboard.press('End');
	await page.keyboard.press('ControlOrMeta+Shift+End');
	await page.keyboard.press('Backspace');
	await expect(editor).toHaveText('The gull flew.');
	await landed;
	release();
	const notice = page.getByText('The image gull.png was not added');
	await expect(notice).toContainText('Undo to bring it back');

	await changeElsewhere(page, 'The gull flew.', 'The gull landed.');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	for (let i = 0; i < 7; i++) await page.keyboard.press('Shift+ArrowLeft');
	await page.keyboard.press('ControlOrMeta+Alt+m');
	await expect(page.getByText('now shows the newer version')).toBeVisible();
	await expect(notice).toHaveText(
		'The image gull.png was not added because its "Uploading" line was changed or removed. Add the image again.'
	);
});
