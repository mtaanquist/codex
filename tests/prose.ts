// Seeded, prose-like scene text for tests that need a long scene a writer
// could have written: paragraphs of sentences over a working vocabulary,
// with "she" common enough that replacing it touches many paragraphs.

export function seeded(seed: number) {
	let state = seed >>> 0 || 1;
	return (below: number) => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		return Math.floor((state / 4294967296) * below);
	};
}

const WORDS = (
	'the a an and but or of in on at to from with into over under through before after ' +
	'harbour lantern window kettle door road river bridge field garden kitchen tower ' +
	'morning evening night winter summer rain snow wind smoke light shadow silence ' +
	'old young cold warm grey dark bright quiet sudden narrow broken heavy careful ' +
	'walked turned waited listened watched opened closed carried pulled reached ' +
	'looked held kept found lost left took gave called answered smiled frowned ' +
	'letter coat hand voice face stone table chair candle book map key boat net ' +
	'Mara Tobin Esk Halvard Ilse Corwen Dunmore Brannock Siv Aldous ' +
	'slowly again once never always almost nearly still only even then there here ' +
	'his her their its our my your this that these those every some no'
).split(' ');

function sentence(next: (below: number) => number, she: number): string {
	const length = 6 + next(13);
	const words: string[] = [];
	for (let i = 0; i < length; i++) {
		words.push(next(100) < she ? 'she' : WORDS[next(WORDS.length)]);
		if (i > 1 && i < length - 2 && next(9) === 0) words[i] += ',';
	}
	words[0] = words[0][0].toUpperCase() + words[0].slice(1);
	return words.join(' ') + ['.', '.', '.', '?', '!'][next(5)];
}

// A paragraph of three to seven sentences. `she` is the chance in a hundred
// that any one word is "she".
export function paragraph(next: (below: number) => number, she = 2): string {
	const count = 3 + next(5);
	return Array.from({ length: count }, () => sentence(next, she)).join(' ');
}

// Paragraphs separated by blank lines, at least `chars` long.
export function sceneParagraphs(seed: number, chars: number, she = 2): string[] {
	const next = seeded(seed);
	const paragraphs: string[] = [];
	let length = 0;
	while (length < chars) {
		const text = paragraph(next, she);
		paragraphs.push(text);
		length += text.length + 2;
	}
	return paragraphs;
}

// `count` short paragraphs of one or two sentences, as in a scene of quick
// exchanges.
export function shortParagraphs(seed: number, count: number): string[] {
	const next = seeded(seed);
	return Array.from({ length: count }, () =>
		Array.from({ length: 1 + next(2) }, () => sentence(next, 2)).join(' ')
	);
}

export const join = (paragraphs: string[]) => paragraphs.join('\n\n');

export const replaceShe = (text: string) => text.replace(/\bshe\b/g, 'Mara');

// Where each paragraph starts in the joined text.
export function paragraphStarts(paragraphs: string[]): number[] {
	const starts: number[] = [];
	let at = 0;
	for (const text of paragraphs) {
		starts.push(at);
		at += text.length + 2;
	}
	return starts;
}

// A few words from the middle of a paragraph that hold no "she" and stand
// once in it, as [start, end) within the paragraph; null if there are none.
export function phraseIn(text: string, words = 3): [number, number] | null {
	const tokens = [...text.matchAll(/\S+/g)];
	for (let from = Math.floor(tokens.length / 3); from + words <= tokens.length; from++) {
		const slice = tokens.slice(from, from + words);
		const start = slice[0].index!;
		const last = slice[slice.length - 1];
		const end = last.index! + last[0].replace(/[,.?!]+$/, '').length;
		const phrase = text.slice(start, end);
		if (/\bshe\b/i.test(phrase) || /[,.?!]/.test(phrase)) continue;
		if (text.indexOf(phrase) !== text.lastIndexOf(phrase)) continue;
		return [start, end];
	}
	return null;
}
