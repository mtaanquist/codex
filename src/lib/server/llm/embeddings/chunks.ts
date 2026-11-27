import { createHash } from 'node:crypto';

// How a scene's markdown is cut into the passages that are embedded. Pure, so
// the cuts are easy to pin down: the indexing job compares each passage's hash
// with what it stored last time and embeds only the passages that changed.

// About 300 tokens: long enough to carry a moment of the story, short enough
// that a passage is about one thing. Paragraphs are packed up to this length;
// a longer paragraph is cut between sentences, and a longer sentence at a space.
export const MAX_CHUNK_CHARS = 1500;

const SENTENCE_END = /(?<=[.!?]["')\]”’]*)\s+/;

// Cuts text with no break in it into pieces of at most max characters, at the
// last space before the limit where there is one.
function hardSplit(text: string, max: number): string[] {
	const out: string[] = [];
	let rest = text;
	while (rest.length > max) {
		const space = rest.lastIndexOf(' ', max);
		const cut = space > max / 2 ? space : max;
		out.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) out.push(rest);
	return out;
}

// Packs pieces into runs of at most max characters, joined by sep.
function pack(pieces: string[], max: number, sep: string): string[] {
	const out: string[] = [];
	let current = '';
	for (const piece of pieces) {
		if (!current) current = piece;
		else if (current.length + sep.length + piece.length <= max) current += sep + piece;
		else {
			out.push(current);
			current = piece;
		}
	}
	if (current) out.push(current);
	return out;
}

function splitParagraph(paragraph: string, max: number): string[] {
	if (paragraph.length <= max) return [paragraph];
	const sentences = paragraph
		.split(SENTENCE_END)
		.flatMap((sentence) => (sentence.length > max ? hardSplit(sentence, max) : [sentence]))
		.filter(Boolean);
	return pack(sentences, max, ' ');
}

// The passages of a scene, in order. Blank text has none.
export function chunkScene(body: string, max = MAX_CHUNK_CHARS): string[] {
	const paragraphs = body
		.replace(/\r\n?/g, '\n')
		.split(/\n[ \t]*\n/)
		.map((p) => p.trim())
		.filter(Boolean)
		.flatMap((p) => splitParagraph(p, max));
	return pack(paragraphs, max, '\n\n');
}

export function chunkHash(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}
