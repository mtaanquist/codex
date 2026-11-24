import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';

// Issue #1450: a large photo is shrunk to 2560 px on its long edge and sent
// as WebP before it uploads. Needs a bucket (CI provides RustFS).
test('a large avatar photo is uploaded shrunk, as WebP', async ({ page }) => {
	test.skip(!process.env.ASSET_S3_BUCKET, 'ASSET_S3_BUCKET not set');
	await gotoReady(page, '/account');

	// A photo-like PNG (a gradient with grain), which compresses far better
	// as WebP.
	const png = await page.evaluate(async () => {
		const canvas = document.createElement('canvas');
		canvas.width = 3200;
		canvas.height = 1600;
		const context = canvas.getContext('2d')!;
		const gradient = context.createLinearGradient(0, 0, 3200, 1600);
		gradient.addColorStop(0, '#2a4d69');
		gradient.addColorStop(1, '#e8b04a');
		context.fillStyle = gradient;
		context.fillRect(0, 0, 3200, 1600);
		const pixels = context.getImageData(0, 0, 3200, 1600);
		let seed = 7;
		for (let i = 0; i < pixels.data.length; i += 4) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			const grain = (seed % 25) - 12;
			pixels.data[i] += grain;
			pixels.data[i + 1] += grain;
			pixels.data[i + 2] += grain;
		}
		context.putImageData(pixels, 0, 0);
		const blob = await new Promise<Blob>((resolve) =>
			canvas.toBlob((b) => resolve(b!), 'image/png')
		);
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = '';
		for (let i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		}
		return btoa(binary);
	});

	const uploaded = page.waitForResponse(
		(r) => r.url().includes('uploadAvatar') && r.request().method() === 'POST'
	);
	await page.locator('input[name="file"]').setInputFiles({
		name: 'photo.png',
		mimeType: 'image/png',
		buffer: Buffer.from(png, 'base64')
	});
	await uploaded;
	const avatar = page.locator('.avatar-lg img');
	await expect(avatar).toBeVisible();
	const served = await page.request.get((await avatar.getAttribute('src'))!);
	expect(served.headers()['content-type']).toBe('image/webp');
	expect((await served.body()).length).toBeLessThan(Buffer.from(png, 'base64').length);
	await expect
		.poll(() => avatar.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]))
		.toEqual([2560, 1280]);

	// Leave the shared test account as it was.
	await page.locator('.avatar-edit').getByRole('button', { name: 'Remove' }).click();
	await expect(page.locator('.avatar-lg img')).toHaveCount(0);
});
