import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';

// The seeded e2e account is a regular user, so it must not reach the admin
// area. The approve/reject behaviour itself is covered by integration tests.
test('the admin area is hidden from non-admins', async ({ page }) => {
	await gotoReady(page, '/');

	const response = await gotoReady(page, '/admin');
	expect(response?.status()).toBe(404);
});

test.describe('signed in with a role', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	async function signIn(page: import('@playwright/test').Page, email: string) {
		await page.goto('/login');
		await page.getByLabel('Email').fill(email);
		await page.getByLabel('Password').fill('e2e-password');
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(page).toHaveURL('/');
	}

	test('an admin sees every section, moderation included', async ({ page }) => {
		await signIn(page, 'admin-e2e@example.com');
		await gotoReady(page, '/admin');
		const nav = page.locator('.admin-nav');
		await expect(nav.getByRole('link', { name: /Users/ })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Instance' })).toBeVisible();
		await nav.getByRole('link', { name: 'Published' }).click();
		await expect(page).toHaveURL('/admin/published');
		await expect(page.getByRole('heading', { name: 'Published editions' })).toBeVisible();
	});

	test('a moderator sees only the moderation pages', async ({ page }) => {
		await signIn(page, 'moderator-e2e@example.com');
		await gotoReady(page, '/admin');
		await expect(page).toHaveURL('/admin/reports');
		await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
		const nav = page.locator('.admin-nav');
		await expect(nav.getByRole('link', { name: /Users/ })).toHaveCount(0);
		const response = await gotoReady(page, '/admin/users');
		expect(response?.status()).toBe(404);
	});

	test('a moderator finds the seeded genre and content warning lists', async ({ page }) => {
		await signIn(page, 'moderator-e2e@example.com');
		await gotoReady(page, '/admin/genres');
		await expect(page.getByRole('heading', { name: 'Genres', level: 1 })).toBeVisible();
		await expect(page.locator('.list-title', { hasText: 'Fantasy' })).toBeVisible();
		await page.locator('.admin-nav').getByRole('link', { name: 'Content warnings' }).click();
		await expect(page).toHaveURL('/admin/warnings');
		await expect(page.locator('.list-title', { hasText: 'Graphic violence' })).toBeVisible();
	});

	test('a tag list page past the end links back to the first page', async ({ page }) => {
		await signIn(page, 'moderator-e2e@example.com');
		await gotoReady(page, '/admin/genres?page=50');
		await expect(page.getByText('No genres on this page.')).toBeVisible();
		await page.getByRole('link', { name: 'Go to the first page' }).click();
		await expect(page).toHaveURL('/admin/genres');
		await expect(page.locator('.list-title', { hasText: 'Fantasy' })).toBeVisible();
	});
});
