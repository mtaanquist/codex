import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { unzipSync, zipSync, strFromU8 } from 'fflate';
import TurndownService from 'turndown';
import mammoth from 'mammoth';
import {
	detectStructure,
	markdownToBlocks,
	splitScenes,
	type DocBlock
} from '../import-document-structure';
import type { ImportedAsset, ImportedFreeformNote, ImportPlan } from '../import-markdown';
import { extensionFor } from './media-types';
import { parseAo3Bodies, type Ao3Work } from './import-ao3';

// Builds an ImportPlan from a Word (.docx) or EPUB (.epub) manuscript: convert
// the document to markdown blocks, let detectStructure guess chapters and
// scenes, and carry embedded images as assets the importer can store. Pure over
// the file bytes; previewImport/runImport take it from here, exactly as they do
// a story-export zip.

export class DocumentImportError extends Error {}

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
// One EPUB spine document, in bytes. Converting one takes roughly 40 to 60
// times its size in memory, so this keeps a conversion well under a gigabyte.
// A whole novel in a single file is a few megabytes.
const MAX_SPINE_FILE_BYTES = 10 * 1024 * 1024;
// The XML of a Word document, all parts together, in bytes. mammoth holds
// about 100 times this in memory while reading it; a long novel's XML is a
// few megabytes.
const MAX_DOCX_XML_BYTES = 10 * 1024 * 1024;

export async function parseDocument(bytes: Uint8Array, filename: string): Promise<ImportPlan> {
	if (bytes.length === 0) throw new DocumentImportError('This file is empty.');
	if (bytes.length > MAX_INPUT_BYTES) {
		throw new DocumentImportError('This file is too large to import (the limit is 25 MB).');
	}
	const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
	if (extension === 'docx') return parseDocx(bytes, filename);
	if (extension === 'epub') return parseEpub(bytes, filename);
	throw new DocumentImportError('Codex can import Word (.docx) and EPUB (.epub) files.');
}

// Converting a document can take tens of seconds (Turndown slows with the
// square of the siblings under one element), so the request path converts in a
// worker thread, which keeps the server answering other requests and is
// stopped after the time limit. The worker runs the TypeScript source, which
// the production image ships for the background worker; the path is resolved
// from the working directory because the bundled server code lives elsewhere.
const WORKER_ENTRY = resolve('src/lib/server/import-document-worker.ts');
const PARSE_TIME_LIMIT_MS = 30_000;
const TOO_SLOW = 'This file took too long to read. Try splitting it into smaller files.';
const TOO_LARGE = 'This file is too large to read. Try splitting it into smaller files.';
const BUSY = 'Another file is being read. Try again in a minute.';
const SECTION_TOO_LARGE =
	'This EPUB has a section too large to import. Try splitting it into smaller files.';
// Each conversion can hold hundreds of megabytes and a core for the full time
// limit, so only this many run at once across the whole server; more are
// turned away rather than queued.
const MAX_RUNNING_CONVERSIONS = 2;
let runningConversions = 0;

type WorkerReply = { plan: ImportPlan } | { importError: string };

export function parseDocumentInWorker(
	bytes: Uint8Array,
	filename: string,
	timeLimitMs = PARSE_TIME_LIMIT_MS
): Promise<ImportPlan> {
	if (runningConversions >= MAX_RUNNING_CONVERSIONS) {
		return Promise.reject(new DocumentImportError(BUSY));
	}
	let worker: Worker;
	try {
		worker = new Worker(WORKER_ENTRY, { workerData: { bytes, filename } });
	} catch (err) {
		return Promise.reject(err);
	}
	// Counted only once the worker exists, so a failed start holds no slot.
	runningConversions++;
	return new Promise((resolvePlan, reject) => {
		// The slot is freed once the worker has stopped, before the caller hears
		// back, so a caller that settles can start another conversion at once.
		const settle = (outcome: () => void) => {
			clearTimeout(timer);
			worker.removeAllListeners();
			// Errors after this point have nowhere to go.
			worker.on('error', () => {});
			const release = () => {
				runningConversions--;
				outcome();
			};
			worker.terminate().then(release, release);
		};
		const timer = setTimeout(
			() => settle(() => reject(new DocumentImportError(TOO_SLOW))),
			timeLimitMs
		);
		worker.once('message', (reply: WorkerReply) =>
			settle(() =>
				'plan' in reply
					? resolvePlan(reply.plan)
					: reject(new DocumentImportError(reply.importError))
			)
		);
		worker.once('error', (err) =>
			settle(() =>
				reject(
					(err as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY'
						? new DocumentImportError(TOO_LARGE)
						: err
				)
			)
		);
		worker.once('exit', (code) =>
			settle(() => reject(new Error(`Document import worker exited with code ${code}`)))
		);
	});
}

// Turndown's time grows with the square of the nesting depth (a blockquote
// prefixes every line inside it once per level), so markup deeper than real
// books go is refused before conversion. Word lists stop at nine levels, and
// AO3 and Calibre output nests a handful of elements deep.
const MAX_NESTING_DEPTH = 64;
// Markdown one document may produce, in characters: as much as the largest
// file Codex accepts, far beyond any real manuscript.
const MAX_MARKDOWN_CHARS = MAX_INPUT_BYTES;

const NESTED_TOO_DEEPLY =
	'This file has formatting nested too deeply to import. Try saving it again from another program.';

// Elements that never hold others, those whose end tag HTML lets a writer
// leave out (an unclosed <p> or <li> ends at the next one, it does not nest),
// and links, which close the one before them. Inside SVG or MathML these
// rules do not apply: every element there nests unless self-closed.
const NON_NESTING_TAGS = new Set(
	(
		'area base br col embed hr img input link meta param source track wbr a ' +
		'p li dt dd option optgroup tr td th thead tbody tfoot colgroup caption rt rp html head body'
	).split(' ')
);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);
// HTML elements that end the SVG or MathML they appear in, as a parser reads
// them, so they and their content are read as HTML.
const FOREIGN_BREAKOUT_TAGS = new Set(
	(
		'b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i ' +
		'img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var'
	).split(' ')
);
// Elements inside SVG or MathML whose content is read as HTML again.
const HTML_INSIDE_FOREIGN = new Set([
	'foreignobject',
	'desc',
	'title',
	'mi',
	'mo',
	'mn',
	'ms',
	'mtext'
]);
const TAG_NAME = /<(\/?)([a-zA-Z][\w:-]*)/y;

type Content = 'html' | 'foreign';

// How the content of a newly opened element is read.
function contentOf(name: string, parent: Content): Content {
	if (parent === 'html') return name === 'svg' || name === 'math' ? 'foreign' : 'html';
	return HTML_INSIDE_FOREIGN.has(name) ? 'html' : 'foreign';
}

// Where an HTML comment opened at i ends (just past it), or -1 when it never
// does. As in an HTML parser, "<!-->" and "<!--->" end at once, and "--!>"
// ends a comment as well as "-->".
function commentEnd(html: string, i: number): number {
	const dashes = html.indexOf('-->', i + 2);
	const bang = html.indexOf('--!>', i + 4);
	if (bang !== -1 && (dashes === -1 || bang < dashes)) return bang + 4;
	return dashes === -1 ? -1 : dashes + 3;
}

// The deepest element nesting in an HTML fragment, in one pass. A stack of
// open tags rather than a parse, so it can overstate sloppy markup a little,
// but it must never understate what Turndown's HTML parser builds. As in an
// HTML parser, an end tag closes the nearest open element of its name and any
// left open inside it, and an end tag with no open element of its name is
// ignored. Outside SVG and MathML, "<span/>" opens a span that stays open, so
// a trailing slash does not close a tag there.
export function nestingDepth(html: string): number {
	const open: string[] = [];
	// How the content of each open element is read, in step with open.
	const contents: Content[] = [];
	// How many of each name are on the stack, so a stray end tag is found
	// without searching it.
	const openCounts = new Map<string, number>();
	const pop = () => {
		const popped = open.pop()!;
		contents.pop();
		openCounts.set(popped, openCounts.get(popped)! - 1);
		return popped;
	};
	let max = 0;
	const push = (name: string, content: Content) => {
		open.push(name);
		contents.push(content);
		openCounts.set(name, (openCounts.get(name) ?? 0) + 1);
		if (open.length > max) max = open.length;
	};
	let i = html.indexOf('<');
	while (i !== -1) {
		if (html.startsWith('<!--', i)) {
			const end = commentEnd(html, i);
			if (end === -1) break;
			i = html.indexOf('<', end);
			continue;
		}
		TAG_NAME.lastIndex = i;
		const match = TAG_NAME.exec(html);
		if (!match) {
			i = html.indexOf('<', i + 1);
			continue;
		}
		const end = html.indexOf('>', TAG_NAME.lastIndex);
		if (end === -1) break;
		const closing = match[1] === '/';
		const name = match[2].toLowerCase();
		let next = end + 1;
		if (closing) {
			if (openCounts.get(name)) while (pop() !== name);
			i = html.indexOf('<', next);
			continue;
		}
		let content: Content = contents.at(-1) ?? 'html';
		// A parser closes the SVG first; staying inside it only overstates.
		if (content === 'foreign' && FOREIGN_BREAKOUT_TAGS.has(name)) content = 'html';
		if (content === 'foreign' || name === 'svg' || name === 'math') {
			if (html[end - 1] !== '/') push(name, contentOf(name, content));
		} else if (RAW_TEXT_TAGS.has(name)) {
			const close = new RegExp(`</${name}`, 'gi');
			close.lastIndex = next;
			if (!close.exec(html)) break;
			next = close.lastIndex - name.length - 2;
		} else if (!NON_NESTING_TAGS.has(name)) {
			push(name, 'html');
		}
		i = html.indexOf('<', next);
	}
	return max;
}

type MarkdownBudget = { chars: number };

function newBudget(): MarkdownBudget {
	return { chars: MAX_MARKDOWN_CHARS };
}

// Turndown escapes literal markdown characters in text, which would turn a
// scene break typed as "***" into "\*\*\*" and hide it from the detector.
// Manuscripts rarely contain deliberate markdown syntax, so leaving text
// verbatim is both safer for break detection and more faithful to the source.
function htmlToMarkdown(html: string, budget: MarkdownBudget): string {
	if (nestingDepth(html) > MAX_NESTING_DEPTH) throw new DocumentImportError(NESTED_TOO_DEEPLY);
	const service = new TurndownService({
		headingStyle: 'atx',
		bulletListMarker: '-',
		codeBlockStyle: 'fenced',
		hr: '* * *',
		emDelimiter: '*'
	});
	service.escape = (text) => text;
	service.remove(['script', 'style', 'title']);
	let markdown: string;
	try {
		markdown = service.turndown(html);
	} catch (err) {
		// Turndown recurses once per nesting level, so a stack overflow means
		// markup nested deeper than the scan above could tell.
		if (err instanceof RangeError) throw new DocumentImportError(NESTED_TOO_DEEPLY);
		throw err;
	}
	budget.chars -= markdown.length;
	if (budget.chars < 0) {
		throw new DocumentImportError('This file has too much text to import as one story.');
	}
	return markdown;
}

function htmlToBlocks(html: string, budget: MarkdownBudget): DocBlock[] {
	return markdownToBlocks(htmlToMarkdown(html, budget));
}

function fileStem(filename: string): string {
	const base = filename.split(/[\\/]/).pop() ?? filename;
	return base
		.replace(/\.[^.]+$/, '')
		.replace(/[_-]+/g, ' ')
		.trim();
}

function buildPlan(
	title: string | null,
	author: string | null,
	chapters: ImportPlan['chapters'],
	assets: ImportedAsset[],
	problems: string[]
): ImportPlan {
	return {
		story: {
			title: title?.trim() || 'Imported story',
			author: author?.trim() || null,
			brief: null,
			descriptionMd: ''
		},
		chapters,
		unfiled: [],
		notes: [],
		assets,
		problems
	};
}

// --- DOCX ---

async function parseDocx(bytes: Uint8Array, filename: string): Promise<ImportPlan> {
	// mammoth's zip reader inflates every entry in full whatever size it
	// declares, so unpack with the size guards first (fflate never writes past
	// the declared size) and hand mammoth an uncompressed copy of what survived.
	const entries = unzipGuarded(bytes, 'Word document');
	if (docxXmlBytes(entries) > MAX_DOCX_XML_BYTES) {
		throw new DocumentImportError(
			'This Word document is too large to import. Try splitting it into smaller files.'
		);
	}
	const bounded = zipSync(entries, { level: 0 });

	const assets: ImportedAsset[] = [];
	const convertImage = mammoth.images.imgElement(async (image) => {
		const buffer = await image.read();
		const id = randomUUID();
		const path = `${id}.${extensionFor(image.contentType ?? '')}`;
		assets.push({ id, path, bytes: new Uint8Array(buffer) });
		return { src: `assets/${path}` };
	});

	let html: string;
	try {
		const result = await mammoth.convertToHtml(
			{ buffer: Buffer.from(bounded.buffer, bounded.byteOffset, bounded.byteLength) },
			{ convertImage }
		);
		html = result.value;
	} catch {
		throw new DocumentImportError('This file could not be read as a Word document.');
	}

	const { chapters, problems } = detectStructure(htmlToBlocks(html, newBudget()));
	const core = docxCoreProperties(entries['docProps/core.xml']);
	return buildPlan(core.title ?? fileStem(filename), core.author, chapters, assets, problems);
}

// The parts mammoth reads as XML: the content types, every relationships
// file, and the main document with its styles, numbering, notes and comments.
// Those are found through relationships, so they can have any name. Every
// target of a relationship of those types counts, from any relationships file,
// as do the default paths mammoth falls back to, so whichever part mammoth
// picks is counted.
const DOCX_PART_TYPES = [
	'officeDocument',
	'comments',
	'endnotes',
	'footnotes',
	'numbering',
	'styles'
];
const DOCX_DEFAULT_PARTS = DOCX_PART_TYPES.map((type) =>
	type === 'officeDocument' ? 'word/document.xml' : `word/${type}.xml`
);
// Excludes "<" outside quotes, so an unclosed tag cannot make every later
// match scan to the end.
const RELATIONSHIP_TAG = /<[\w:.-]*Relationship\b((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>/g;

function attrValues(attrs: string, name: string): string[] {
	const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'g');
	// An XML parser reads tabs and line breaks in an attribute as spaces.
	return [...attrs.matchAll(re)].map((m) => decodeEntities(m[1] ?? m[2]).replace(/[\t\n\r]/g, ' '));
}

function docxXmlBytes(entries: Record<string, Uint8Array>): number {
	const relsFiles = Object.keys(entries).filter((name) => /\.rels$/i.test(name));
	const parts = new Set(['[Content_Types].xml', ...DOCX_DEFAULT_PARTS, ...relsFiles]);
	const size = () => [...parts].reduce((sum, part) => sum + (entries[part]?.length ?? 0), 0);
	// Too large already without the parts they point at.
	if (size() > MAX_DOCX_XML_BYTES) return size();
	for (const name of relsFiles) {
		// mammoth reads a part's relationships from "<dir>/_rels/<part>.rels",
		// and resolves their targets against <dir>.
		const source = name.match(/^(?:(.*)\/)?_rels\/[^/]*$/i);
		if (!source) continue;
		const dir = source[1] ?? '';
		for (const [, attrs] of strFromU8(entries[name]).matchAll(RELATIONSHIP_TAG)) {
			const types = attrValues(attrs, 'Type');
			if (!types.some((type) => DOCX_PART_TYPES.some((part) => type.endsWith(`/${part}`)))) {
				continue;
			}
			for (const target of attrValues(attrs, 'Target')) {
				const path = target.startsWith('/') || dir === '' ? target : `${dir}/${target}`;
				parts.add(path.replace(/^\//, ''));
			}
		}
	}
	return size();
}

// Word stores its title and author in docProps/core.xml.
function docxCoreProperties(core: Uint8Array | undefined): {
	title: string | null;
	author: string | null;
} {
	if (!core) return { title: null, author: null };
	const xml = strFromU8(core);
	return { title: tagText(xml, 'dc:title'), author: tagText(xml, 'dc:creator') };
}

// --- EPUB ---

async function parseEpub(bytes: Uint8Array, filename: string): Promise<ImportPlan> {
	const entries = unzipGuarded(bytes, 'EPUB');
	const container = entries['META-INF/container.xml'];
	if (!container) throw new DocumentImportError('This EPUB is missing its container file.');
	const opfPath = attr(strFromU8(container), 'full-path');
	if (!opfPath || !entries[opfPath]) {
		throw new DocumentImportError('This EPUB does not point to a readable package file.');
	}
	const opf = strFromU8(entries[opfPath]);
	const opfDir = posixDirname(opfPath);

	const manifest = new Map<string, string>();
	for (const tag of opf.match(/<item\b[^>]*\/?>/g) ?? []) {
		const id = attr(tag, 'id');
		const href = attr(tag, 'href');
		if (id && href) manifest.set(id, href);
	}
	const spine: string[] = [];
	for (const tag of opf.match(/<itemref\b[^>]*\/?>/g) ?? []) {
		const idref = attr(tag, 'idref');
		if (idref) spine.push(idref);
	}

	const assets: ImportedAsset[] = [];
	const assetPaths = new Map<string, string>();
	const bodies: string[] = [];
	for (const idref of spine) {
		const href = manifest.get(idref);
		if (!href) continue;
		const path = posixResolve(opfDir, decodePath(href));
		const data = entries[path];
		if (!data || !/\.x?html?$/i.test(path)) continue;
		if (data.length > MAX_SPINE_FILE_BYTES) throw new DocumentImportError(SECTION_TOO_LARGE);
		const rewritten = rewriteEpubImages(strFromU8(data), path, entries, assets, assetPaths);
		bodies.push(extractBody(rewritten));
	}

	const title = tagText(opf, 'dc:title') ?? fileStem(filename);
	const author = tagText(opf, 'dc:creator');

	if (tagText(opf, 'dc:publisher') === 'Archive of Our Own') {
		const work = parseAo3Bodies(bodies);
		if (work && work.chapters.length > 0) return buildAo3Plan(title, author, work, assets);
	}

	const files: { title: string | null; blocks: DocBlock[] }[] = [];
	const budget = newBudget();
	for (const body of bodies) {
		const blocks = htmlToBlocks(body, budget);
		if (blocks.length === 0) continue;
		const firstHeading = blocks.find((b) => b.kind === 'heading');
		files.push({
			title: firstHeading?.kind === 'heading' ? firstHeading.text.trim() || null : null,
			blocks
		});
	}

	// Headings win when the book marks chapters with them. Otherwise fall back to
	// the EPUB's own file split: one spine document per chapter, the convention
	// most reflowable EPUBs follow.
	const combined = detectStructure(files.flatMap((file) => file.blocks));
	if (combined.chapters.length > 1 || files.length <= 1) {
		return buildPlan(title, author, combined.chapters, assets, combined.problems);
	}

	const chapters = files.map((file) => ({
		title: file.title,
		scenes: detectStructure(file.blocks).chapters.flatMap((chapter) => chapter.scenes)
	}));
	return buildPlan(title, author, chapters, assets, []);
}

// An AO3 download maps onto Codex's own fields: the summary becomes the
// description, an Explicit or Mature rating flags the story adult, chapter
// summaries land on the chapter, and the tag list and every author's note
// become story notes rather than prose.
function buildAo3Plan(
	title: string,
	author: string | null,
	work: Ao3Work,
	assets: ImportedAsset[]
): ImportPlan {
	// A chapter's prose can join several spine files, so it gets their cap.
	for (const chapter of work.chapters) {
		if (Buffer.byteLength(chapter.proseHtml) > MAX_SPINE_FILE_BYTES) {
			throw new DocumentImportError(SECTION_TOO_LARGE);
		}
	}
	const budget = newBudget();
	const md = (html: string | null) => (html ? htmlToMarkdown(html, budget).trim() : '');
	const notes: ImportedFreeformNote[] = [];
	const addNote = (
		noteTitle: string,
		bodyMd: string,
		scene: ImportedFreeformNote['scene'] = null,
		pinned = false
	) => {
		if (bodyMd !== '') notes.push({ title: noteTitle, bodyMd, pinned, scene, createdAt: null });
	};

	const details = work.tags
		.filter(([label]) => label !== 'Stats')
		.map(([label, values]) => `- **${label}:** ${values.join(', ')}`);
	if (work.sourceUrl) details.unshift(`Imported from ${work.sourceUrl}`, '');
	addNote('Archive of Our Own details', details.join('\n'), null, true);
	addNote('Notes', md(work.notesHtml));

	const chapters = work.chapters.map((chapter, index) => {
		const scenes = splitScenes(htmlToBlocks(chapter.proseHtml, budget));
		const name = chapter.title ? `Chapter ${index + 1}: ${chapter.title}` : `Chapter ${index + 1}`;
		addNote(`${name} notes`, md(chapter.notesHtml), { chapter: index, index: 0 });
		addNote(`${name} end notes`, md(chapter.endNotesHtml), {
			chapter: index,
			index: scenes.length - 1
		});
		return { title: chapter.title, summaryMd: md(chapter.summaryHtml) || null, scenes };
	});
	addNote('End notes', md(work.endNotesHtml));

	const rating = work.tags.find(([label]) => label === 'Rating')?.[1] ?? [];
	const plan = buildPlan(title, author, chapters, assets, []);
	plan.story.descriptionMd = md(work.summaryHtml);
	plan.story.isAdult = rating.some((value) => value === 'Explicit' || value === 'Mature');
	plan.freeformNotes = notes;
	return plan;
}

function rewriteEpubImages(
	html: string,
	filePath: string,
	entries: Record<string, Uint8Array>,
	assets: ImportedAsset[],
	assetPaths: Map<string, string>
): string {
	const dir = posixDirname(filePath);
	return html.replace(/<img\b[^>]*>/gi, (tag) => {
		const src = attr(tag, 'src');
		if (!src) return tag;
		const resolved = posixResolve(dir, decodePath(src));
		const data = entries[resolved];
		if (!data) return tag;
		// One stored copy per image file, however often the book shows it.
		let path = assetPaths.get(resolved);
		if (!path) {
			const ext = resolved.slice(resolved.lastIndexOf('.') + 1).toLowerCase() || 'bin';
			const id = randomUUID();
			path = `${id}.${ext}`;
			assets.push({ id, path, bytes: data });
			assetPaths.set(resolved, path);
		}
		return tag.replace(/\bsrc\s*=\s*("[^"]*"|'[^']*')/i, `src="assets/${path}"`);
	});
}

// --- shared XML/zip/path helpers ---

function unzipGuarded(
	bytes: Uint8Array,
	kind: 'EPUB' | 'Word document'
): Record<string, Uint8Array> {
	let count = 0;
	let total = 0;
	try {
		return unzipSync(bytes, {
			filter(file) {
				if (++count > MAX_ENTRIES) {
					throw new DocumentImportError(`This ${kind} has too many files to import.`);
				}
				// fflate inflates to the declared size but copies stored entries
				// by their stored size, so count whichever is larger.
				const unpacked = Math.max(file.size, file.originalSize);
				if (unpacked > MAX_ENTRY_BYTES) {
					throw new DocumentImportError(
						`This ${kind} contains a file that is too large to import.`
					);
				}
				total += unpacked;
				if (total > MAX_TOTAL_BYTES) {
					throw new DocumentImportError(`This ${kind} is too large to import once unpacked.`);
				}
				return true;
			}
		});
	} catch (err) {
		if (err instanceof DocumentImportError) throw err;
		const article = kind === 'EPUB' ? 'an' : 'a';
		throw new DocumentImportError(`This file could not be read as ${article} ${kind}.`);
	}
}

function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

// The first value of an attribute on a single tag string, single or double
// quoted. Enough for the constrained, well-formed XML of EPUB packages.
function attr(tag: string, name: string): string | null {
	const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
	if (!match) return null;
	return decodeEntities(match[1] ?? match[2] ?? '');
}

function tagText(xml: string, tag: string): string | null {
	const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
	if (!match) return null;
	const text = decodeEntities(match[1].replace(/<[^>]+>/g, '')).trim();
	return text === '' ? null : text;
}

function extractBody(html: string): string {
	const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
	return match ? match[1] : html;
}

// An EPUB href without its fragment, percent-decoded. A malformed escape is
// read as written, which is also how a zip stores a name containing "%".
function decodePath(href: string): string {
	const path = href.split('#')[0];
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

function posixDirname(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

function posixResolve(dir: string, rel: string): string {
	const segments = dir === '' ? [] : dir.split('/');
	for (const part of rel.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') segments.pop();
		else segments.push(part);
	}
	return segments.join('/');
}
