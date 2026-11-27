import { expect, test, type Browser, type Page } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';
import { violations } from './axe';

// Browse: an author lists a public story, a signed-out reader finds it, and it
// leaves Browse when the story stops being public. Turns Browse on for the run
// and off again after, so the other specs see the default.

// Through the admin page rather than the database: the server caches the
// setting, and only a save clears that cache.
async function setBrowse(browser: Browser, enabled: boolean) {
	const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
	try {
		const page = await context.newPage();
		await gotoReady(page, '/admin/instance');
		const box = page.getByRole('checkbox', { name: 'Browse page' });
		if ((await box.isChecked()) === enabled) return;
		// The input hides behind the toggle-track skin, so click its label.
		await page.locator('label.toggle', { has: box }).click();
		await expect(box).toBeChecked({ checked: enabled });
		await expect(page.getByText('Saved.')).toBeVisible();
	} finally {
		await context.close();
	}
}

test.describe.configure({ mode: 'serial' });
test.afterAll(async ({ browser }) => {
	await setBrowse(browser, false);
});

test('a listed public story shows on Browse until it is made private', async ({
	page,
	browser
}) => {
	await setBrowse(browser, true);
	const stamp = Date.now();
	const title = `Browse story ${stamp}`;

	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Browse world ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Browse world ${stamp}`);
	await page.getByLabel('New story').fill(title);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText(title);
	await gotoReady(page, page.url());
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.locator('.cm-content').click();
	await page.keyboard.type('The bell rang twice.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	const storyPath = new URL(page.url()).pathname;

	await gotoReady(page, `${storyPath}/settings/publish`);
	await page.getByLabel('Visibility').selectOption('public');
	await page.getByLabel('List in Browse').check();
	await page.getByRole('button', { name: 'Save visibility' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await page.getByRole('button', { name: 'Publish edition' }).click();
	const penPrompt = page.getByRole('dialog', { name: 'Choose your author name' });
	if (await penPrompt.isVisible()) {
		await penPrompt.getByRole('button', { name: 'Continue' }).click();
	}
	await expect(page.getByRole('status')).toContainText('Edition published.');

	const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const reader = await anonymous.newPage();
	await gotoReady(reader, '/');
	await reader.getByRole('banner').getByRole('link', { name: 'Browse' }).click();
	await expect(reader).toHaveURL('/browse');
	await reader.getByLabel('Search stories').fill(`${stamp}`);
	await reader.getByRole('button', { name: 'Search' }).click();
	await expect(reader.locator('.shelf-item-title')).toHaveText([title]);
	expect(await violations(reader)).toEqual([]);

	// On a confirmed adult story, the label links include adult work in Browse,
	// so they do not leave out the story they came from.
	await page.getByLabel('Adult content').check();
	await page.getByRole('button', { name: 'Save visibility' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await gotoReady(page, `${storyPath}/settings/publish`);
	await page.getByRole('checkbox', { name: 'Fantasy' }).check();
	await page.getByRole('button', { name: 'Save tags' }).click();
	await expect(page.getByRole('status')).toHaveText(/Saved\./);
	await page.getByRole('button', { name: 'Publish edition' }).click();
	const published = page.getByRole('status').filter({ hasText: 'Edition published.' });
	await expect(published.or(penPrompt)).toBeVisible();
	if (await penPrompt.isVisible()) {
		await penPrompt.getByRole('button', { name: 'Continue' }).click();
	}
	const readingPath = await published.getByRole('link').getAttribute('href');
	const storyPage = await anonymous.newPage();
	await gotoReady(storyPage, readingPath!);
	await storyPage.getByRole('link', { name: /I am of legal age/ }).click();
	await expect(storyPage).toHaveURL(/adult=ok/);
	await expect(storyPage.getByRole('link', { name: 'Fantasy' })).toHaveAttribute(
		'href',
		/[?&]genre=fantasy&adult=show$/
	);
	await storyPage.close();

	await gotoReady(page, `${storyPath}/settings/publish`);
	await page.getByLabel('Visibility').selectOption('private');
	await page.getByRole('button', { name: 'Save visibility' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');

	await reader.reload();
	await expect(reader.locator('.browse-empty')).toBeVisible();
	await anonymous.close();
});

test('Browse includes adult work on load once a reader searched with it', async ({ browser }) => {
	await setBrowse(browser, true);
	const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const reader = await anonymous.newPage();
	const adultBox = reader.getByLabel('Include adult content');

	await gotoReady(reader, '/browse');
	await expect(adultBox).not.toBeChecked();
	await adultBox.check();
	await reader.getByRole('button', { name: 'Search' }).click();
	await expect(reader).toHaveURL(/adult=show/);
	// Going back to the page from before the search shows adult work, and the
	// address says so.
	await reader.goBack();
	await expect(adultBox).toBeChecked();
	await expect(reader).toHaveURL('/browse?adult=show');

	// A full load and a link inside the app both bring the choice back.
	await gotoReady(reader, '/browse?q=bell');
	await expect(reader).toHaveURL('/browse?q=bell&adult=show');
	await expect(adultBox).toBeChecked();
	// Inside the app, the page without adult work is never fetched first.
	const unfiltered: string[] = [];
	reader.on('request', (request) => {
		const url = new URL(request.url());
		if (url.pathname === '/browse/__data.json' && url.searchParams.get('adult') !== 'show') {
			unfiltered.push(url.href);
		}
	});
	await gotoReady(reader, '/');
	await reader.getByRole('banner').getByRole('link', { name: 'Browse' }).click();
	await expect(reader).toHaveURL('/browse?adult=show');
	// A link that does not carry the choice is sent there before it loads.
	await reader.evaluate(() => {
		const link = document.createElement('a');
		link.href = '/browse?q=bell';
		link.textContent = 'Plain link';
		link.dataset.sveltekitPreloadData = 'off';
		document.getElementById('main')!.append(link);
	});
	await reader.getByRole('link', { name: 'Plain link' }).click();
	await expect(reader).toHaveURL('/browse?q=bell&adult=show');
	expect(unfiltered).toEqual([]);

	// Unticking and searching leaves adult work out from then on.
	await adultBox.uncheck();
	await reader.getByRole('button', { name: 'Search' }).click();
	await expect(reader).not.toHaveURL(/adult=/);
	await gotoReady(reader, '/browse');
	await expect(reader).toHaveURL('/browse');
	await expect(adultBox).not.toBeChecked();
	await anonymous.close();
});

// Publishes a public story listed in Browse, with one free-form tag and the
// Fantasy genre, and returns its reading page's address.
async function publishListed(
	page: Page,
	universe: string,
	title: string,
	tag: string,
	adult = false
): Promise<string> {
	await gotoReady(page, '/');
	await startStoryInUniverse(page, universe);
	await page.getByLabel('New story').fill(title);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText(title);
	await gotoReady(page, page.url());
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.locator('.cm-content').click();
	await page.keyboard.type('The bell rang twice.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	const storyPath = new URL(page.url()).pathname;
	await gotoReady(page, `${storyPath}/settings/publish`);
	await page.getByLabel('Visibility').selectOption('public');
	await page.getByLabel('List in Browse').check();
	if (adult) await page.getByLabel('Adult content').check();
	await page.getByRole('button', { name: 'Save visibility' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await page.getByRole('checkbox', { name: 'Fantasy' }).check();
	await page.getByRole('button', { name: 'Tags', exact: true }).click();
	await page.getByLabel('Add tag').fill(tag);
	await page.getByLabel('Add tag').press('Enter');
	await page.getByRole('button', { name: 'Save tags' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
	await page.getByRole('button', { name: 'Publish edition' }).click();
	const penPrompt = page.getByRole('dialog', { name: 'Choose your author name' });
	const published = page.getByRole('status').filter({ hasText: 'Edition published.' });
	await expect(published.or(penPrompt)).toBeVisible();
	if (await penPrompt.isVisible()) {
		await penPrompt.getByRole('button', { name: 'Continue' }).click();
	}
	return (await published.getByRole('link').getAttribute('href'))!;
}

test('a reading page shows similar stories, with adult work once the reader chose it', async ({
	page,
	browser
}) => {
	await setBrowse(browser, true);
	const stamp = Date.now();
	const universe = `Similar world ${stamp}`;
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(universe);
	await page.getByRole('button', { name: 'Create universe' }).click();
	const plainPath = await publishListed(page, universe, `Plain ${stamp}`, `bells ${stamp}`);
	const adultPath = await publishListed(page, universe, `Grown ${stamp}`, `bells ${stamp}`, true);
	// A third listed story, so the shared tag is not on every listed story.
	await publishListed(page, universe, `Other ${stamp}`, `ships ${stamp}`);

	const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const reader = await anonymous.newPage();
	const similar = reader.getByRole('region', { name: 'Similar stories' });

	// The only match is adult work, so a reader who has not chosen it sees none.
	await gotoReady(reader, plainPath);
	await expect(reader.getByRole('heading', { name: `Plain ${stamp}` })).toBeVisible();
	await expect(similar).toHaveCount(0);

	// On the confirmed adult story, the plain one shows.
	await gotoReady(reader, `${adultPath}?adult=ok`);
	await expect(similar.locator('.shelf-item-title')).toHaveText([`Plain ${stamp}`]);

	// Once Browse remembers the adult choice, the plain story's page shows it too.
	await reader.evaluate(() => localStorage.setItem('codex:browse-adult', 'show'));
	await gotoReady(reader, plainPath);
	await expect(similar.locator('.shelf-item-title')).toHaveText([`Grown ${stamp}`]);
	expect(await violations(reader)).toEqual([]);
	await anonymous.close();
});

test('Browse does not exist while it is off', async ({ page, browser }) => {
	await setBrowse(browser, false);
	const response = await gotoReady(page, '/browse');
	expect(response?.status()).toBe(404);
});
