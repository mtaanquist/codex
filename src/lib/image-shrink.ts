// Shrinks a still image in the browser before it is uploaded: anything longer
// than MAX_IMAGE_EDGE on its long edge is scaled down to that, and anything
// over the per-image byte limit is re-encoded smaller (lower WebP quality,
// then fewer pixels) until it fits. A PNG stays a PNG unless a WebP is far
// smaller. The original goes up unchanged when it fits already, when it may
// be animated (every GIF, an animated PNG, WebP or AVIF), when the browser
// cannot decode or encode it, or when nothing that fits is smaller. The
// server checks every upload the same way either way.

import { MAX_IMAGE_BYTES } from './quota.ts';

export const MAX_IMAGE_EDGE = 2560;
// Enough of the file to find the markers that say whether it is animated.
const HEAD_BYTES = 64 * 1024;
// WebP qualities tried at each size, then the sizes tried, as shares of the
// first size, until a result fits the byte limit.
const WEBP_QUALITIES = [0.85, 0.7, 0.55];
const SCALES = [1, 0.75, 0.5, 0.35, 0.25];
// A PNG is re-encoded as a PNG (lossless), unless the WebP at the same size is
// at most this share of it: a photo saved as a PNG, rather than a screenshot.
const LOSSY_SHARE = 0.2;
// A PNG walk gives up (and counts the file as animated) after this many chunks.
const MAX_PNG_CHUNKS = 1000;

/** The size to scale to, or null when the image already fits. */
export function targetSize(
	width: number,
	height: number,
	maxEdge = MAX_IMAGE_EDGE
): { width: number; height: number } | null {
	const longEdge = Math.max(width, height);
	if (longEdge <= maxEdge) return null;
	const scale = maxEdge / longEdge;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale))
	};
}

export type EncodeType = 'image/png' | 'image/webp';
export type Encoding = { width: number; height: number; type: EncodeType; quality?: number };

/**
 * The encodings shrinkImage tries, in order, for an image to be sent at this
 * size: at each size (the full one, then smaller shares of it) a PNG first
 * when the source is a PNG, then WebP at falling quality.
 */
export function encodingPlan(width: number, height: number, png: boolean): Encoding[] {
	const plan: Encoding[] = [];
	for (const scale of SCALES) {
		const w = Math.max(1, Math.round(width * scale));
		const h = Math.max(1, Math.round(height * scale));
		if (png) plan.push({ width: w, height: h, type: 'image/png' });
		for (const quality of WEBP_QUALITIES) {
			plan.push({ width: w, height: h, type: 'image/webp', quality });
		}
	}
	return plan;
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
	return String.fromCharCode(...bytes.subarray(from, to));
}

function uint32(bytes: Uint8Array, at: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0);
}

function isPng(head: Uint8Array): boolean {
	return head.length >= 8 && head[0] === 0x89 && ascii(head, 1, 4) === 'PNG';
}

/**
 * Whether a PNG file is a still image: no acTL chunk before its first IDAT.
 * It reads only the 8-byte chunk headers, using each chunk's length to skip
 * its data, so large chunks before the image data cost nothing. A file that
 * ends (or runs past MAX_PNG_CHUNKS) before an IDAT counts as animated, so it
 * is left alone.
 */
export async function isStillPng(file: Blob): Promise<boolean> {
	let at = 8;
	for (let i = 0; i < MAX_PNG_CHUNKS && at + 8 <= file.size; i++) {
		const header = new Uint8Array(await file.slice(at, at + 8).arrayBuffer());
		const type = ascii(header, 4, 8);
		if (type === 'acTL') return false;
		if (type === 'IDAT') return true;
		at += 12 + uint32(header, 0);
	}
	return false;
}

// An animated WebP is an extended (VP8X) file with the animation flag set.
function isStillWebp(head: Uint8Array): boolean {
	return !(head.length > 20 && ascii(head, 12, 16) === 'VP8X' && (head[20] & 0x02) !== 0);
}

// An AVIF image sequence carries the avis brand in its ftyp box.
function isStillAvif(head: Uint8Array): boolean {
	const size = Math.min(uint32(head, 0), head.length);
	const brands = [ascii(head, 8, 12)];
	for (let at = 16; at + 4 <= size; at += 4) brands.push(ascii(head, at, at + 4));
	return brands.includes('avif') && !brands.includes('avis');
}

/** Whether the file is a still PNG, JPEG, WebP or AVIF, the images it is safe
 * to re-encode. GIFs and anything unrecognised are not. */
export async function isStillImage(file: Blob): Promise<boolean> {
	const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
	if (head.length < 12) return false;
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
	if (isPng(head)) return isStillPng(file);
	if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return isStillWebp(head);
	if (ascii(head, 4, 8) === 'ftyp') return isStillAvif(head);
	return false;
}

/** The file name with its extension swapped for the type's (.webp or .png). */
export function renamed(name: string, type: EncodeType): string {
	const ext = type === 'image/png' ? 'png' : 'webp';
	return `${name.replace(/\.[^./]*$/, '') || 'image'}.${ext}`;
}

export type DecodedImage = {
	width: number;
	height: number;
	// The image drawn at this size in this type; null, or another type, when
	// the browser cannot encode it.
	encode(encoding: Encoding): Promise<Blob | null>;
	close(): void;
};

export type ImageCodec = { decode(file: Blob): Promise<DecodedImage> };

async function draw(bitmap: ImageBitmap, { width, height, type, quality }: Encoding) {
	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d');
		if (!context) return null;
		context.imageSmoothingQuality = 'high';
		context.drawImage(bitmap, 0, 0, width, height);
		return canvas.convertToBlob({ type, quality });
	}
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) return null;
	context.imageSmoothingQuality = 'high';
	context.drawImage(bitmap, 0, 0, width, height);
	return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

const browserCodec: ImageCodec = {
	async decode(file) {
		// Turned upright by its EXIF orientation, so width and height are the
		// image as it is shown.
		const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
		return {
			width: bitmap.width,
			height: bitmap.height,
			encode: (encoding) => draw(bitmap, encoding),
			close: () => bitmap.close()
		};
	}
};

/** The file to upload: a smaller copy of a large still image, or the file
 * itself. maxBytes is the account's per-image limit. Never throws. */
export async function shrinkImage(
	file: File,
	maxBytes = MAX_IMAGE_BYTES,
	codec: ImageCodec = browserCodec
): Promise<File> {
	try {
		if (!(await isStillImage(file))) return file;
		const png = isPng(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
		const image = await codec.decode(file);
		try {
			const size = targetSize(image.width, image.height);
			if (!size && file.size <= maxBytes) return file;
			const base = size ?? { width: image.width, height: image.height };
			const pick = await firstFit(image, encodingPlan(base.width, base.height, png), maxBytes);
			if (!pick || pick.blob.size >= file.size) return file;
			return new File([pick.blob], renamed(file.name, pick.type), {
				type: pick.type,
				lastModified: file.lastModified
			});
		} finally {
			image.close();
		}
	} catch {
		return file;
	}
}

// The first encoding in the plan that fits maxBytes, encoding lazily. A PNG
// that fits is kept over the WebP after it unless that WebP is far smaller.
async function firstFit(image: DecodedImage, plan: Encoding[], maxBytes: number) {
	let png: Blob | null = null;
	for (const step of plan) {
		const blob = await image.encode(step);
		const ok = blob && blob.type === step.type ? blob : null;
		if (step.type === 'image/png') {
			png = ok;
			continue;
		}
		let pick: { blob: Blob; type: EncodeType } | null = ok && { blob: ok, type: step.type };
		if (png) {
			if (png.size <= maxBytes && !(ok && ok.size <= png.size * LOSSY_SHARE)) {
				pick = { blob: png, type: 'image/png' };
			}
			png = null;
		}
		if (pick && pick.blob.size <= maxBytes) return pick;
	}
	return null;
}

export type ShrinkOptions = {
	// The account's per-image limit; the largest any account has by default.
	maxBytes?: number;
	// Called with true while the images shrink and false when the form goes,
	// so the form can show that it is busy.
	onBusy?: (busy: boolean) => void;
};

/**
 * A form action for plain (not enhanced) upload forms: on submit, it holds the
 * submit back, swaps each chosen image for shrinkImage's result, and submits
 * again. If the swap fails, the form goes with the files as chosen.
 */
export function shrinkImagesOnSubmit(form: HTMLFormElement, initial: ShrinkOptions = {}) {
	let options = initial;
	let busy = false;
	let again = false;
	let ready = false;
	let submitter: HTMLElement | null = null;

	async function swapFiles() {
		for (const input of form.querySelectorAll<HTMLInputElement>('input[type="file"]')) {
			const picked = [...(input.files ?? [])];
			if (picked.length === 0) continue;
			const shrunk: File[] = [];
			for (const file of picked) shrunk.push(await shrinkImage(file, options.maxBytes));
			// A file picked again meanwhile is left for the next pass.
			const now = [...(input.files ?? [])];
			if (now.length !== picked.length || now.some((file, i) => file !== picked[i])) continue;
			const transfer = new DataTransfer();
			for (const file of shrunk) transfer.items.add(file);
			input.files = transfer.files;
		}
	}

	async function onSubmit(event: SubmitEvent) {
		if (ready) return;
		event.preventDefault();
		submitter = event.submitter;
		// A submit while a pass runs (a second pick on a form that submits on
		// change) runs one more pass on the files chosen now.
		if (busy) {
			again = true;
			return;
		}
		busy = true;
		form.setAttribute('aria-busy', 'true');
		options.onBusy?.(true);
		try {
			do {
				again = false;
				await swapFiles().catch(() => {});
			} while (again);
		} finally {
			busy = false;
			form.removeAttribute('aria-busy');
			options.onBusy?.(false);
		}
		// requestSubmit fires the submit event synchronously, so the flag
		// covers exactly the one submit it starts.
		ready = true;
		try {
			try {
				form.requestSubmit(submitter);
			} catch {
				// The submit button left the form while the files were swapped.
				form.requestSubmit();
			}
		} finally {
			ready = false;
		}
	}
	form.addEventListener('submit', onSubmit);
	return {
		update: (next: ShrinkOptions = {}) => (options = next),
		destroy: () => form.removeEventListener('submit', onSubmit)
	};
}
