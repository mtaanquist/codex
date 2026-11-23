import { describe, expect, it, vi } from 'vitest';
import {
	isStillImage,
	MAX_IMAGE_EDGE,
	shrinkImage,
	shrinkImagesOnSubmit,
	targetSize,
	webpName,
	type ImageCodec
} from './image-shrink';

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

describe('isStillImage', () => {
	it('accepts a JPEG, a still PNG, a still WebP and a still AVIF', () => {
		expect(isStillImage(jpeg)).toBe(true);
		expect(isStillImage(png('IDAT'))).toBe(true);
		expect(isStillImage(webp('VP8 '))).toBe(true);
		expect(isStillImage(webp('VP8X', 0x10))).toBe(true);
		expect(isStillImage(avif('avif', 'mif1', 'miaf'))).toBe(true);
	});

	it('refuses every GIF and the animated forms of the others', () => {
		expect(isStillImage(gif)).toBe(false);
		expect(isStillImage(png('acTL', 'IDAT'))).toBe(false);
		expect(isStillImage(webp('VP8X', 0x02))).toBe(false);
		expect(isStillImage(avif('avis', 'avif', 'msf1'))).toBe(false);
	});

	it('refuses a PNG whose first image data is not in the bytes read', () => {
		expect(isStillImage(png('tEXt'))).toBe(false);
	});

	it('refuses anything else', () => {
		expect(isStillImage(new Uint8Array(text('<svg xmlns="x"></svg>')))).toBe(false);
		expect(isStillImage(new Uint8Array([0xff, 0xd8]))).toBe(false);
	});
});

describe('webpName', () => {
	it('swaps the extension', () => {
		expect(webpName('holiday.photo.JPG')).toBe('holiday.photo.webp');
		expect(webpName('scan')).toBe('scan.webp');
		expect(webpName('.png')).toBe('image.webp');
	});
});

describe('shrinkImage', () => {
	const photo = (bytes: number) =>
		new File([jpeg, new Uint8Array(bytes)], 'photo.jpg', { type: 'image/jpeg' });

	function codec(
		width: number,
		height: number,
		result: Blob | null | (() => never)
	): ImageCodec & { encoded: unknown[]; closed: () => boolean } {
		const encoded: unknown[] = [];
		let closed = false;
		return {
			encoded,
			closed: () => closed,
			async decode() {
				return {
					width,
					height,
					async encode(w, h) {
						encoded.push({ width: w, height: h });
						return typeof result === 'function' ? result() : result;
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
		const result = await shrinkImage(original, fake);
		expect(result).not.toBe(original);
		expect(result.name).toBe('photo.webp');
		expect(result.type).toBe('image/webp');
		expect(result.size).toBe(500);
		expect(fake.encoded).toEqual([{ width: 2560, height: 1707 }]);
		expect(fake.closed()).toBe(true);
	});

	it('leaves an image that already fits alone', async () => {
		const fake = codec(2000, 1500, new Blob([new Uint8Array(10)], { type: 'image/webp' }));
		const original = photo(5000);
		expect(await shrinkImage(original, fake)).toBe(original);
		expect(fake.encoded).toEqual([]);
		expect(fake.closed()).toBe(true);
	});

	it('keeps the original when the WebP is not smaller', async () => {
		const original = photo(100);
		const bigger = new Blob([new Uint8Array(original.size)], { type: 'image/webp' });
		expect(await shrinkImage(original, codec(6000, 4000, bigger))).toBe(original);
	});

	it('keeps the original when the browser cannot encode WebP', async () => {
		const original = photo(5000);
		// Browsers without a WebP encoder hand back a PNG instead.
		const asPng = new Blob([new Uint8Array(10)], { type: 'image/png' });
		expect(await shrinkImage(original, codec(6000, 4000, asPng))).toBe(original);
		expect(await shrinkImage(original, codec(6000, 4000, null))).toBe(original);
	});

	it('keeps the original when decoding or encoding fails', async () => {
		const original = photo(5000);
		const broken: ImageCodec = {
			decode: () => Promise.reject(new Error('cannot decode'))
		};
		expect(await shrinkImage(original, broken)).toBe(original);
		const throwing = codec(6000, 4000, () => {
			throw new Error('out of memory');
		});
		expect(await shrinkImage(original, throwing)).toBe(original);
		expect(throwing.closed()).toBe(true);
	});

	it('never decodes a GIF', async () => {
		const decode = vi.fn();
		const original = new File([gif], 'loop.gif', { type: 'image/gif' });
		expect(await shrinkImage(original, { decode })).toBe(original);
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

	it('still submits when that button has left the form', async () => {
		const { form, submit } = fakeForm((submitter) => {
			if (submitter) throw new DOMException('gone', 'NotFoundError');
		});
		await submit({});
		expect(form.requestSubmit).toHaveBeenCalledTimes(2);
		expect(form.requestSubmit).toHaveBeenLastCalledWith();
	});
});
