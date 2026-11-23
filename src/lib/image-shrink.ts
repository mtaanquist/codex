// Shrinks a large still image in the browser before it is uploaded: anything
// longer than MAX_IMAGE_EDGE on its long edge is scaled down to that and
// re-encoded as WebP. The original goes up unchanged when it is small enough
// already, when it may be animated (every GIF, an animated PNG, WebP or AVIF),
// when the browser cannot decode it or encode WebP, or when the result is not
// smaller. The server checks every upload the same way either way.

export const MAX_IMAGE_EDGE = 2560;
const WEBP_QUALITY = 0.85;
// Enough of the file to find the markers that say whether it is animated.
const HEAD_BYTES = 64 * 1024;

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

function ascii(bytes: Uint8Array, from: number, to: number): string {
	return String.fromCharCode(...bytes.subarray(from, to));
}

function uint32(bytes: Uint8Array, at: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0);
}

// An animated PNG has an acTL chunk before its first IDAT. Not knowing (the
// chunks run past the head) counts as animated, so the file is left alone.
function isStillPng(head: Uint8Array): boolean {
	let at = 8;
	while (at + 8 <= head.length) {
		const type = ascii(head, at + 4, at + 8);
		if (type === 'acTL') return false;
		if (type === 'IDAT') return true;
		at += 12 + uint32(head, at);
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

/** Whether the file's first bytes are a still PNG, JPEG, WebP or AVIF, the
 * images it is safe to re-encode. GIFs and anything unrecognised are not. */
export function isStillImage(head: Uint8Array): boolean {
	if (head.length < 12) return false;
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
	if (head[0] === 0x89 && ascii(head, 1, 4) === 'PNG') return isStillPng(head);
	if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return isStillWebp(head);
	if (ascii(head, 4, 8) === 'ftyp') return isStillAvif(head);
	return false;
}

/** The file name with its extension swapped for .webp. */
export function webpName(name: string): string {
	return `${name.replace(/\.[^./]*$/, '') || 'image'}.webp`;
}

export type DecodedImage = {
	width: number;
	height: number;
	// The image drawn at this size as WebP; null, or another type, when the
	// browser cannot encode WebP.
	encode(width: number, height: number): Promise<Blob | null>;
	close(): void;
};

export type ImageCodec = { decode(file: Blob): Promise<DecodedImage> };

async function drawToWebp(bitmap: ImageBitmap, width: number, height: number) {
	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d');
		if (!context) return null;
		context.imageSmoothingQuality = 'high';
		context.drawImage(bitmap, 0, 0, width, height);
		return canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
	}
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) return null;
	context.imageSmoothingQuality = 'high';
	context.drawImage(bitmap, 0, 0, width, height);
	return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY));
}

const browserCodec: ImageCodec = {
	async decode(file) {
		// Turned upright by its EXIF orientation, so width and height are the
		// image as it is shown.
		const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
		return {
			width: bitmap.width,
			height: bitmap.height,
			encode: (width, height) => drawToWebp(bitmap, width, height),
			close: () => bitmap.close()
		};
	}
};

/** The file to upload: a smaller WebP copy of a large still image, or the
 * file itself. Never throws. */
export async function shrinkImage(file: File, codec: ImageCodec = browserCodec): Promise<File> {
	try {
		const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
		if (!isStillImage(head)) return file;
		const image = await codec.decode(file);
		try {
			const size = targetSize(image.width, image.height);
			if (!size) return file;
			const blob = await image.encode(size.width, size.height);
			if (!blob || blob.type !== 'image/webp' || blob.size >= file.size) return file;
			return new File([blob], webpName(file.name), {
				type: 'image/webp',
				lastModified: file.lastModified
			});
		} finally {
			image.close();
		}
	} catch {
		return file;
	}
}

/**
 * A form action for plain (not enhanced) upload forms: on submit, it holds the
 * submit back, swaps each chosen image for shrinkImage's result, and submits
 * again.
 */
export function shrinkImagesOnSubmit(form: HTMLFormElement) {
	let busy = false;
	let ready = false;
	async function onSubmit(event: SubmitEvent) {
		if (ready) return;
		event.preventDefault();
		if (busy) return;
		busy = true;
		try {
			for (const input of form.querySelectorAll<HTMLInputElement>('input[type="file"]')) {
				if (!input.files?.length) continue;
				const transfer = new DataTransfer();
				for (const file of input.files) transfer.items.add(await shrinkImage(file));
				input.files = transfer.files;
			}
		} finally {
			busy = false;
		}
		// requestSubmit fires the submit event synchronously, so the flag
		// covers exactly the one submit it starts.
		ready = true;
		try {
			form.requestSubmit(event.submitter);
		} finally {
			ready = false;
		}
	}
	form.addEventListener('submit', onSubmit);
	return { destroy: () => form.removeEventListener('submit', onSubmit) };
}
