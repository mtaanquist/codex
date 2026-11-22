import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';
import { addEntity } from './plan';

// An axe pass over the main pages in light and dark. It fails only on the
// rules the accessibility fixes have brought to zero, so a regression in one
// of them breaks the build; widen RULES as more of them are fixed.
const RULES = [
	// Contrast (#721).
	'color-contrast',
	// Page titles (#724).
	'document-title',
	// Page structure (#726).
	'bypass',
	'page-has-heading-one',
	'landmark-one-main',
	'landmark-no-duplicate-main',
	'landmark-no-duplicate-banner',
	'landmark-unique',
	'region',
	// Hidden menus stay out of the tab order (#720).
	'aria-hidden-focus',
	// Control names (#725).
	'aria-input-field-name',
	'button-name',
	'label',
	'link-name',
	'select-name'
];

async function violations(page: Page) {
	const results = await new AxeBuilder({ page }).withRules(RULES).analyze();
	return results.violations.map(
		(v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`
	);
}

// Sets the palette on the page once it has hydrated, after the layout has
// applied the account's own theme. Saving a theme instead would change the
// shared e2e user that other specs run as in parallel. Transitions are cut so
// axe reads the new colours, not a fade between the two palettes.
async function useTheme(page: Page, theme: 'light' | 'dark') {
	await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
	await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
}

test.describe.configure({ mode: 'serial' });

let storyPath = '';
let universePlanPath = '';
let suggestionsPath = '';
let consentPath = '';
let readingPath = '';
let draftPath = '';

test.beforeAll(async ({ browser }) => {
	test.setTimeout(90_000);
	const page = await browser.newPage({ storageState: 'e2e/.auth/e2e.json' });
	await gotoReady(page, '/');
	const universeName = `Axe universe ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	universePlanPath = `${new URL(page.url()).pathname}/plan`;
	suggestionsPath = `${new URL(page.url()).pathname}/suggestions`;
	// The page an outside app sends the writer to.
	const registered = await page.request.post('/oauth/register', {
		data: { client_name: 'Axe Desk', redirect_uris: ['https://axe.example/callback'] }
	});
	const { client_id: clientId } = await registered.json();
	consentPath =
		'/oauth/authorize?' +
		new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: 'https://axe.example/callback',
			code_challenge: 'x'.repeat(43),
			code_challenge_method: 'S256',
			scope: 'read suggest'
		});
	await gotoReady(page, universePlanPath);
	await addEntity(page, 'Add character', 'Maren');
	await expect(page).toHaveURL(/entity=/);
	universePlanPath = new URL(page.url()).pathname + new URL(page.url()).search;

	await gotoReady(page, '/');
	await startStoryInUniverse(page, universeName);
	await page.getByLabel('New story').fill('Axe story');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Axe story');
	await gotoReady(page, page.url());
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.locator('.cm-content').click();
	await page.keyboard.type('The lamps were lit along the harbour wall.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	storyPath = new URL(page.url()).pathname;

	// A comment and a suggested edit, so the review page is checked with its
	// cards and margin markers showing.
	await gotoReady(page, `${storyPath}/review`);
	const prose = page.locator('.review-edit .cm-content');
	const selectProse = async () => {
		const box = (await prose.locator('.cm-line').first().boundingBox())!;
		await page.mouse.move(box.x + 3, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2, { steps: 10 });
		await page.mouse.up();
	};
	await selectProse();
	await page.locator('.rv-seltool').getByRole('button', { name: 'Comment' }).click();
	await page.getByLabel('Your comment').fill('Tighten this line.');
	await page
		.locator('.rv-card.is-draft')
		.getByRole('button', { name: 'Comment', exact: true })
		.click();
	await expect(page.locator('.rv-card').filter({ hasText: 'Tighten this line.' })).toBeVisible();
	await selectProse();
	await page.locator('.rv-seltool').getByRole('button', { name: 'Suggest edit' }).click();
	await page.getByLabel('Suggested text').fill('The lamps burned along the harbour wall.');
	await page.getByRole('button', { name: 'Save suggestion' }).click();
	await expect(page.locator('.rv-diff-ins')).toHaveText('The lamps burned along the harbour wall.');

	await gotoReady(page, `${storyPath}/settings/publish`);
	await page.getByLabel('Visibility').selectOption('public');
	await page.getByRole('button', { name: 'Save visibility' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await page.getByRole('button', { name: 'Publish edition' }).click();
	const penPrompt = page.getByRole('dialog', { name: 'Choose your author name' });
	if (await penPrompt.isVisible()) {
		await penPrompt.getByRole('button', { name: 'Continue' }).click();
	}
	await expect(page.getByRole('status')).toContainText('Edition published.');

	await gotoReady(page, `${storyPath}/settings/drafts`);
	await page.locator('#draft-label').fill('Axe draft');
	await page.getByRole('button', { name: 'Save draft' }).click();
	const openDraft = page.getByRole('link', { name: 'Open it' });
	await expect(openDraft).toBeVisible();
	draftPath = (await openDraft.getAttribute('href')) as string;

	await gotoReady(page, '/@e2e-tester');
	readingPath = (await page
		.getByRole('link', { name: 'Axe story' })
		.first()
		.getAttribute('href')) as string;
	await page.close();
});

const signedIn = () => [
	['library', '/'],
	['story workspace', storyPath],
	['plan', `${storyPath}/plan`],
	['review', `${storyPath}/review`],
	['saved draft', draftPath],
	['saved draft compare', `${draftPath}?tab=compare`],
	['account', '/account'],
	['connected apps', '/account/apps'],
	['universe suggestions', suggestionsPath],
	['connect an app', consentPath],
	['help article', '/docs/editor'],
	['not found', '/does-not-exist']
];

const signedOut = () => [
	['sign in', '/login'],
	['sign in with a link', '/login/link'],
	['public story', readingPath],
	['not found', '/@nobody-here/no-such-story']
];

for (const theme of ['light', 'dark'] as const) {
	test(`signed-in pages pass in ${theme}`, async ({ page }) => {
		for (const [name, url] of signedIn()) {
			await gotoReady(page, url);
			await useTheme(page, theme);
			expect(await violations(page), name).toEqual([]);
		}
	});

	test.describe(() => {
		test.use({ storageState: { cookies: [], origins: [] } });

		test(`signed-out pages pass in ${theme}`, async ({ page }) => {
			for (const [name, url] of signedOut()) {
				await gotoReady(page, url);
				await useTheme(page, theme);
				expect(await violations(page), name).toEqual([]);
			}
		});
	});
}

test('the skip link is the first stop and moves focus into main', async ({ page }) => {
	await gotoReady(page, '/');
	await page.keyboard.press('Tab');
	const skip = page.getByRole('link', { name: 'Skip to content' });
	await expect(skip).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('main')).toBeFocused();
});

test('workspace pages have one h1 and named side panes', async ({ page }) => {
	for (const url of [
		storyPath,
		`${storyPath}?view=story`,
		`${storyPath}?view=preview`,
		`${storyPath}/plan`,
		`${storyPath}/notes`,
		`${storyPath}/review`,
		`${storyPath}/print`
	]) {
		await gotoReady(page, url);
		await expect(page.getByRole('heading', { level: 1 }), url).toHaveCount(1);
		await expect(page.getByRole('main'), url).toHaveCount(1);
	}
	await gotoReady(page, storyPath);
	await expect(page.getByRole('complementary', { name: 'Sidebar' })).toHaveCount(1);
	await expect(page.getByRole('complementary', { name: 'Side panel' })).toHaveCount(1);
});

test('print preview has one main and one banner', async ({ page }) => {
	await gotoReady(page, `${storyPath}/print`);
	await expect(page.getByRole('main')).toHaveCount(1);
	await expect(page.getByRole('banner')).toHaveCount(1);
});

test('editors are named', async ({ page }) => {
	await gotoReady(page, storyPath);
	await expect(page.getByRole('textbox', { name: 'Scene text' })).toBeVisible();
	await gotoReady(page, universePlanPath);
	await expect(page.getByRole('textbox', { name: 'Description' })).toBeVisible();
});

test('the formatting bar is one tab stop with arrow keys between tools', async ({ page }) => {
	await page.setViewportSize({ width: 1600, height: 900 });
	await gotoReady(page, storyPath);
	const bar = page.getByRole('toolbar', { name: 'Formatting' });
	const tools = bar.locator('button:visible, a[href]:visible');
	await expect(bar.locator('[tabindex="0"]')).toHaveCount(1);

	await tools.first().focus();
	await page.keyboard.press('ArrowRight');
	await expect(tools.nth(1)).toBeFocused();
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('ArrowLeft');
	await expect(tools.last()).toBeFocused();
	await page.keyboard.press('Home');
	await expect(tools.first()).toBeFocused();

	// Tab leaves the bar instead of walking through every tool.
	await page.keyboard.press('Tab');
	await expect(bar.locator(':focus')).toHaveCount(0);

	// A focused tool that moves into "More tools" as the bar narrows leaves
	// focus in the bar. (At 960px and narrower the writing takes the full width, so it
	// takes a phone width to crowd the bar.)
	await bar.getByRole('button', { name: 'Split scene at cursor' }).focus();
	await page.setViewportSize({ width: 390, height: 900 });
	await expect(bar.getByRole('button', { name: 'Split scene at cursor' })).toHaveCount(0);
	await expect(bar.locator(':focus')).toHaveCount(1);
});
