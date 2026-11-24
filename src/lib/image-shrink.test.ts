import { describe, expect, it, vi } from 'vitest';
import {
	encodingPlan,
	isStillImage,
	isStillPng,
	MAX_IMAGE_EDGE,
	renamed,
	shrinkImage,
	shrinkImagesOnSubmit,
	targetSize,
	type Encoding,
	type ImageCodec
} from './image-shrink';
import { MAX_IMAGE_BYTES } from './quota';

const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, length = 0) => [...u32(length), ...text(type), ...Array(length + 4)];

const PNG_SIG = [0x89, ...text('PNG'), 0x0d, 0x0a, 0x1a, 0x0a];
const png = (...types: string[]) =>
	new Uint8Array([...PNG_SIG, ...chunk('IHDR', 13), ...types.flatMap((t) => chunk(t, 8))]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array(20)]);
const webp = (fourcc: string, flags = 0) =>
	new Uint8Array([
		...text('RIFF'),
		...u32(0),
		...text('WEBP'),
		...text(fourcc),
		0,
		0,
		0,
		0,
		flags,
		0,
		0,
		0
	]);
const avif = (...brands: string[]) => {
	const body = [...text('ftyp'), ...text(brands[0]), 0, 0, 0, 0, ...brands.flatMap(text)];
	return new Uint8Array([...u32(body.length + 4), ...body]);
};
const gif = new Uint8Array([...text('GIF89a'), ...Array(20)]);

describe('targetSize', () => {
	it('leaves an image that fits alone', () => {
		expect(targetSize(MAX_IMAGE_EDGE, 1000)).toBeNull();
		expect(targetSize(800, 600)).toBeNull();
	});

	it('scales the long edge down to the limit and keeps the shape', () => {
		expect(targetSize(5120, 3840)).toEqual({ width: 2560, height: 1920 });
		expect(targetSize(3000, 6000)).toEqual({ width: 1280, height: 2560 });
	});

	it('never scales a side to nothing', () => {
		expect(targetSize(100_000, 10)).toEqual({ width: 2560, height: 1 });
	});
});

const blob = (bytes: Uint8Array | number[]) => new Blob([new Uint8Array(bytes)]);

describe('encodingPlan', () => {
	it('tries WebP at falling quality, then smaller sizes', () => {
		const plan = encodingPlan(2000, 1000, false);
		expect(plan.every((step) => step.type === 'image/webp')).toBe(true);
		expect(plan.slice(0, 4)).toEqual([
			{ width: 2000, height: 1000, type: 'image/webp', quality: 0.85 },
			{ width: 2000, height: 1000, type: 'image/webp', quality: 0.7 },
			{ width: 2000, height: 1000, type: 'image/webp', quality: 0.55 },
			{ width: 1500, height: 750, type: 'image/webp', quality: 0.85 }
		]);
		const last = plan[plan.length - 1];
		expect(last.width).toBeLessThan(1000);
	});

	it('tries a PNG first at each size for a PNG', () => {
		const plan = encodingPlan(2000, 1000, true);
		expect(plan[0]).toEqual({ width: 2000, height: 1000, type: 'image/png' });
		expect(plan[1].type).toBe('image/webp');
		expect(plan.filter((step) => step.type === 'image/png').map((step) => step.width)).toEqual([
			2000, 1500, 1000, 700, 500
		]);
	});
});

describe('isStillImage', () => {
	it('accepts a JPEG, a still PNG, a still WebP and a still AVIF', async () => {
		expect(await isStillImage(blob(jpeg))).toBe(true);
		expect(await isStillImage(blob(png('IDAT')))).toBe(true);
		expect(await isStillImage(blob(webp('VP8 ')))).toBe(true);
		expect(await isStillImage(blob(webp('VP8X', 0x10)))).toBe(true);
		expect(await isStillImage(blob(avif('avif', 'mif1', 'miaf')))).toBe(true);
	});

	it('refuses every GIF and the animated forms of the others', async () => {
		expect(await isStillImage(blob(gif))).toBe(false);
		expect(await isStillImage(blob(png('acTL', 'IDAT')))).toBe(false);
		expect(await isStillImage(blob(webp('VP8X', 0x02)))).toBe(false);
		expect(await isStillImage(blob(avif('avis', 'avif', 'msf1')))).toBe(false);
	});

	it('refuses a PNG that ends before its image data', async () => {
		expect(await isStillImage(blob(png('tEXt')))).toBe(false);
	});

	it('refuses anything else', async () => {
		expect(await isStillImage(blob(text('<svg xmlns="x"></svg>')))).toBe(false);
		expect(await isStillImage(blob([0xff, 0xd8]))).toBe(false);
	});
});

describe('isStillPng', () => {
	// A PNG with one large chunk ahead of the rest, past the first 64 KB.
	const withBigChunk = (...after: string[]) =>
		new Blob([
			new Uint8Array([...PNG_SIG, ...chunk('IHDR', 13)]),
			new Uint8Array([...u32(200_000), ...text('iCCP')]),
			new Uint8Array(200_000 + 4),
			new Uint8Array(after.flatMap((t) => chunk(t, 8)))
		]);

	it('walks past a large chunk to find the image data', async () => {
		expect(await isStillPng(withBigChunk('IDAT'))).toBe(true);
		expect(await isStillImage(withBigChunk('IDAT'))).toBe(true);
	});

	it('still finds an animation chunk after a large chunk', async () => {
		expect(await isStillPng(withBigChunk('acTL', 'IDAT'))).toBe(false);
	});

	it('reads only the chunk headers, not the data between them', async () => {
		const file = withBigChunk('IDAT');
		const slice = vi.spyOn(file, 'slice');
		await isStillPng(file);
		expect(slice.mock.calls.every(([from, to]) => (to ?? 0) - (from ?? 0) === 8)).toBe(true);
		expect(slice).toHaveBeenCalledTimes(3);
	});

	it('counts a file cut off mid-chunk as not still', async () => {
		const cut = new Blob([
			new Uint8Array([...PNG_SIG, ...chunk('IHDR', 13)]),
			new Uint8Array(u32(500))
		]);
		expect(await isStillPng(cut)).toBe(false);
	});
});

describe('renamed', () => {
	it('swaps the extension for the new type', () => {
		expect(renamed('holiday.photo.JPG', 'image/webp')).toBe('holiday.photo.webp');
		expect(renamed('scan', 'image/webp')).toBe('scan.webp');
		expect(renamed('.png', 'image/webp')).toBe('image.webp');
		expect(renamed('screen.PNG', 'image/png')).toBe('screen.png');
	});
});

describe('shrinkImage', () => {
	const photo = (bytes: number) =>
		new File([jpeg, new Uint8Array(bytes)], 'photo.jpg', { type: 'image/jpeg' });
	const screenshot = (bytes: number) =>
		new File([png('IDAT'), new Uint8Array(bytes)], 'screen.png', { type: 'image/png' });

	// A fake browser: each encoding comes out at the size the function gives,
	// or null for one the browser cannot make.
	function codec(
		width: number,
		height: number,
		result: Blob | null | ((step: Encoding) => number | null) | (() => never)
	): ImageCodec & { encoded: Encoding[]; closed: () => boolean } {
		const encoded: Encoding[] = [];
		let closed = false;
		return {
			encoded,
			closed: () => closed,
			async decode() {
				return {
					width,
					height,
					async encode(step) {
						encoded.push(step);
						if (typeof result !== 'function') return result;
						const size = result(step);
						return size === null ? null : new Blob([new Uint8Array(size)], { type: step.type });
					},
					close: () => {
						closed = true;
					}
				};
			}
		};
	}

	it('sends a large photo as a smaller WebP at the limit', async () => {
		const fake = codec(6000, 4000, new Blob([new Uint8Array(500)], { type: 'image/webp' }));
		const original = photo(5000);
		const result = await shrinkImage(original, MAX_IMAGE_BYTES, fake);
		expect(result).not.toBe(original);
		expect(result.name).toBe('photo.webp');
		expect(result.type).toBe('image/webp');
		expect(result.size).toBe(500);
		expect(fake.encoded).toEqual([
			{ width: 2560, height: 1707, type: 'image/webp', quality: 0.85 }
		]);
		expect(fake.closed()).toBe(true);
	});

	it('leaves an image that already fits alone', async () => {
		const fake = codec(2000, 1500, new Blob([new Uint8Array(10)], { type: 'image/webp' }));
		const original = photo(5000);
		expect(await shrinkImage(original, MAX_IMAGE_BYTES, fake)).toBe(original);
		expect(fake.encoded).toEqual([]);
		expect(fake.closed()).toBe(true);
	});

	it('steps down quality, then size, until the result fits the byte limit', async () => {
		// Each step down halves the bytes; the fourth try is the first to fit.
		let bytes = 16_000;
		const fake = codec(6000, 4000, () => (bytes /= 2));
		const result = await shrinkImage(photo(20_000), 1000, fake);
		expect(result.size).toBe(1000);
		expect(fake.encoded.map((step) => [step.width, step.quality])).toEqual([
			[2560, 0.85],
			[2560, 0.7],
			[2560, 0.55],
			[1920, 0.85]
		]);
	});

	it('re-encodes a small image that is over the byte limit at the same size', async () => {
		const fake = codec(1000, 800, () => 300);
		const result = await shrinkImage(photo(5000), 1000, fake);
		expect(result.size).toBe(300);
		expect(fake.encoded[0]).toMatchObject({ width: 1000, height: 800 });
	});

	it('sends the original when nothing fits, for the server to refuse', async () => {
		const original = photo(5000);
		const fake = codec(1000, 800, () => 2000);
		expect(await shrinkImage(original, 1000, fake)).toBe(original);
		expect(fake.encoded).toHaveLength(15);
	});

	it('keeps a PNG lossless unless the WebP is far smaller', async () => {
		const original = screenshot(50_000);
		const close = codec(5120, 2880, (step) => (step.type === 'image/png' ? 10_000 : 4000));
		const kept = await shrinkImage(original, MAX_IMAGE_BYTES, close);
		expect(kept.type).toBe('image/png');
		expect(kept.name).toBe('screen.png');
		expect(kept.size).toBe(10_000);

		const far = codec(5120, 2880, (step) => (step.type === 'image/png' ? 10_000 : 1500));
		const lossy = await shrinkImage(original, MAX_IMAGE_BYTES, far);
		expect(lossy.type).toBe('image/webp');
		expect(lossy.size).toBe(1500);
	});

	it('falls back to WebP for a PNG whose PNG copy is over the byte limit', async () => {
		const fake = codec(5120, 2880, (step) => (step.type === 'image/png' ? 9000 : 800));
		const result = await shrinkImage(screenshot(50_000), 1000, fake);
		expect(result.type).toBe('image/webp');
		expect(result.size).toBe(800);
	});

	it('keeps the PNG copy when the browser cannot encode WebP', async () => {
		const fake = codec(5120, 2880, (step) => (step.type === 'image/png' ? 10_000 : null));
		const result = await shrinkImage(screenshot(50_000), MAX_IMAGE_BYTES, fake);
		expect(result.type).toBe('image/png');
	});

	it('keeps the original when the result is not smaller', async () => {
		const original = photo(100);
		const bigger = new Blob([new Uint8Array(original.size)], { type: 'image/webp' });
		expect(await shrinkImage(original, MAX_IMAGE_BYTES, codec(6000, 4000, bigger))).toBe(original);
	});

	it('keeps the original when the browser cannot encode WebP', async () => {
		const original = photo(5000);
		// Browsers without a WebP encoder hand back a PNG instead.
		const asPng = new Blob([new Uint8Array(10)], { type: 'image/png' });
		expect(await shrinkImage(original, MAX_IMAGE_BYTES, codec(6000, 4000, asPng))).toBe(original);
		expect(await shrinkImage(original, MAX_IMAGE_BYTES, codec(6000, 4000, null))).toBe(original);
	});

	it('keeps the original when decoding or encoding fails', async () => {
		const original = photo(5000);
		const broken: ImageCodec = {
			decode: () => Promise.reject(new Error('cannot decode'))
		};
		expect(await shrinkImage(original, MAX_IMAGE_BYTES, broken)).toBe(original);
		const throwing = codec(6000, 4000, () => {
			throw new Error('out of memory');
		});
		expect(await shrinkImage(original, MAX_IMAGE_BYTES, throwing)).toBe(original);
		expect(throwing.closed()).toBe(true);
	});

	it('never decodes a GIF', async () => {
		const decode = vi.fn();
		const original = new File([gif], 'loop.gif', { type: 'image/gif' });
		expect(await shrinkImage(original, MAX_IMAGE_BYTES, { decode })).toBe(original);
		expect(decode).not.toHaveBeenCalled();
	});
});

describe('shrinkImagesOnSubmit', () => {
	// Just enough of a form for the action: no file inputs, so the pass has
	// nothing to swap and goes straight to submitting again.
	function fakeForm(requestSubmit: (submitter?: HTMLElement | null) => void) {
		let listener: ((event: SubmitEvent) => Promise<void>) | undefined;
		const form = {
			addEventListener: (_: string, fn: typeof listener) => (listener = fn),
			removeEventListener: () => {},
			setAttribute: () => {},
			removeAttribute: () => {},
			querySelectorAll: () => [],
			requestSubmit: vi.fn(requestSubmit)
		};
		shrinkImagesOnSubmit(form as unknown as HTMLFormElement);
		const submit = (submitter: unknown) =>
			listener!({ preventDefault: () => {}, submitter } as unknown as SubmitEvent);
		return { form, submit };
	}

	it('submits again with the button that was pressed', async () => {
		const { form, submit } = fakeForm(() => {});
		const button = {};
		await submit(button);
		expect(form.requestSubmit).toHaveBeenCalledExactlyOnceWith(button);
	});

	it('reports that it is busy while the images shrink', async () => {
		let listener: ((event: SubmitEvent) => Promise<void>) | undefined;
		const events: string[] = [];
		const form = {
			addEventListener: (_: string, fn: typeof listener) => (listener = fn),
			removeEventListener: () => {},
			setAttribute: vi.fn(),
			removeAttribute: vi.fn(),
			querySelectorAll: () => [],
			requestSubmit: () => events.push('submit')
		};
		shrinkImagesOnSubmit(form as unknown as HTMLFormElement, {
			onBusy: (busy) => events.push(busy ? 'busy' : 'done')
		});
		await listener!({ preventDefault: () => {}, submitter: null } as unknown as SubmitEvent);
		expect(events).toEqual(['busy', 'done', 'submit']);
		expect(form.setAttribute).toHaveBeenCalledWith('aria-busy', 'true');
		expect(form.removeAttribute).toHaveBeenCalledWith('aria-busy');
	});

	it('still submits when that button has left the form', async () => {
		const { form, submit } = fakeForm((submitter) => {
			if (submitter) throw new DOMException('gone', 'NotFoundError');
		});
		await submit({});
		expect(form.requestSubmit).toHaveBeenCalledTimes(2);
		expect(form.requestSubmit).toHaveBeenLastCalledWith();
	});
});
