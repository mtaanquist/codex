import { unzipSync, strFromU8 } from 'fflate';
import { isSceneStatus, type SceneStatus } from './scene-status';
import { UUID_BODY } from './slug';
import { toLf } from './line-endings';
import { normaliseLanguage, type WritingLanguage } from './writing-languages';
import {
	MAX_ASSISTANT_NOTES,
	normaliseNotes,
	preferencesFromLines,
	type StoredPreferences
} from './assistant-preferences';

// Parses our own story export zip back into a plan the importer can write:
// story metadata, chapters and scenes in NN- prefix order, story notes, and
// bundled assets. Pure over the zip bytes; tolerant of the gaps older zips
// have (no chapter.md, say) but strict about being a story export at all.

export type ImportedScene = { title: string | null; status: SceneStatus | null; bodyMd: string };
export type ImportedChapter = {
	title: string | null;
	// Only document imports that carry chapter summaries (AO3) set this.
	summaryMd?: string | null;
	scenes: ImportedScene[];
};
export type ImportedNote = {
	kind: 'character' | 'place' | 'lore';
	name: string;
	notesMd: string;
};
// A freeform story note from the notebook/ folder. The scene it hangs off is
// a position in the plan (chapter index, or null for unfiled, and the scene's
// index within it); older zips carry none of pinned, scene, or created.
export type ImportedFreeformNote = {
	title: string | null;
	bodyMd: string;
	pinned: boolean;
	scene: { chapter: number | null; index: number } | null;
	createdAt: Date | null;
};
// An undecided draft from the account export's waiting-drafts/ folder, on the
// scene at that plan position.
export type ImportedWaitingDraft = {
	scene: { chapter: number | null; index: number };
	brief: string;
	targetWords: number | null;
	pov: string | null;
	note: string | null;
	chapterBrief: string | null;
	// Who wrote it; a file without the field is the Assistant's.
	source: 'assistant' | 'app';
	textMd: string;
};
export type ImportedAsset = { id: string; path: string; bytes: Uint8Array };
export type ImportPlan = {
	story: {
		title: string;
		author: string | null;
		brief: string | null;
		descriptionMd: string;
		// Absent unless the source carries a rating (AO3) or a Codex export
		// says so.
		isAdult?: boolean;
		// From a Codex export's story.md; keys and names as written there,
		// checked against the lists when the story is created.
		genres?: string[];
		contentWarnings?: string[];
		tags?: string[];
		fandoms?: string[];
		// The writer's settings from a Codex export's story.md, each absent
		// when the file does not set it.
		styleNotes?: string;
		language?: WritingLanguage;
		assistantPreferences?: StoredPreferences;
		assistantNotes?: string;
	};
	chapters: ImportedChapter[];
	unfiled: ImportedScene[];
	notes: ImportedNote[];
	// Absent from plans built from a manuscript document rather than a zip.
	freeformNotes?: ImportedFreeformNote[];
	waitingDrafts?: ImportedWaitingDraft[];
	assets: ImportedAsset[];
	// Tolerated oddities worth telling the author about before they commit.
	problems: string[];
};

export class StoryZipError extends Error {}

// A zip's central directory reports each entry's uncompressed size before we
// spend memory decompressing it, so a malicious archive (a small file that
// expands to gigabytes, or one with millions of entries) is rejected up front
// rather than after it has exhausted the process.
const MAX_ENTRIES = 5000;
const SAVED_DRAFT_PATH = /^[^/]+\/drafts\//;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

type FrontMatter = Record<string, string | string[]>;

// The exporter writes a constrained front matter subset: JSON-quoted scalar
// lines and two-space-indented JSON-quoted list items. Parse exactly that,
// falling back to the raw text for a value that does not parse as JSON.
export function parseFrontMatter(text: string): { fields: FrontMatter; body: string } {
	const lines = text.split('\n');
	if (lines[0] !== '---') return { fields: {}, body: text };
	const close = lines.indexOf('---', 1);
	if (close === -1) return { fields: {}, body: text };

	const fields: FrontMatter = {};
	let listKey: string | null = null;
	for (const line of lines.slice(1, close)) {
		const item = line.match(/^ {2}- (.*)$/);
		if (item && listKey) {
			(fields[listKey] as string[]).push(parseScalar(item[1]));
			continue;
		}
		const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(.*)$/);
		if (!pair) continue;
		const value = pair[2].trim();
		if (value === '') {
			listKey = pair[1];
			fields[listKey] = [];
		} else {
			listKey = null;
			fields[pair[1]] = parseScalar(value);
		}
	}
	return { fields, body: lines.slice(close + 1).join('\n') };
}

function parseScalar(value: string): string {
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === 'string' ? parsed : value;
	} catch {
		return value;
	}
}

function scalar(fields: FrontMatter, key: string): string | null {
	const value = fields[key];
	return typeof value === 'string' && value !== '' ? value : null;
}

function list(fields: FrontMatter, key: string): string[] {
	const value = fields[key];
	return Array.isArray(value) ? value.filter((item) => item.trim() !== '') : [];
}

// The reader labels story.md carries, leaving out the ones it does not.
function labelLists(fields: FrontMatter) {
	const lists = {
		genres: list(fields, 'genres'),
		contentWarnings: list(fields, 'content-warnings'),
		tags: list(fields, 'tags'),
		fandoms: list(fields, 'fandoms')
	};
	return Object.fromEntries(Object.entries(lists).filter(([, value]) => value.length > 0));
}

// The language and Assistant settings story.md carries. A value this site
// cannot use is left off and reported, so the preview names it before the
// story is created.
function assistantSettings(fields: FrontMatter, problems: string[]) {
	const out: {
		styleNotes?: string;
		language?: WritingLanguage;
		assistantPreferences?: StoredPreferences;
		assistantNotes?: string;
	} = {};
	const styleNotes = scalar(fields, 'style-notes');
	if (styleNotes) out.styleNotes = styleNotes;
	const rawLanguage = scalar(fields, 'language');
	if (rawLanguage) {
		const language = normaliseLanguage(rawLanguage);
		if (language) out.language = language;
		else
			problems.push(
				`story.md: the language "${rawLanguage}" is not one this site knows, so the story uses its universe's.`
			);
	}
	const lines = list(fields, 'assistant-preferences');
	if (lines.length > 0) {
		const { preferences, unread } = preferencesFromLines(lines);
		if (Object.keys(preferences).length > 0) out.assistantPreferences = preferences;
		if (unread > 0) {
			problems.push('story.md: some Assistant preferences were not recognised and were left off.');
		}
	}
	const notes = normaliseNotes(scalar(fields, 'assistant-notes'));
	if (notes && notes.length > MAX_ASSISTANT_NOTES) {
		problems.push(
			`story.md: the Assistant notes are longer than ${MAX_ASSISTANT_NOTES} characters, so they were left off.`
		);
	} else if (notes) {
		out.assistantNotes = notes;
	}
	return out;
}

// "01-the-toll-road" -> "The toll road"; the readable fallback when a title
// only survives as a slug (chapter folders from zips older than chapter.md).
function deslug(name: string): string | null {
	const words = name.replace(/^\d+-/, '').split('-').filter(Boolean).join(' ');
	if (!words) return null;
	return words[0].toUpperCase() + words.slice(1);
}

// The NN- prefix that orders chapter folders and scene files.
function orderOf(name: string): number {
	const match = name.match(/^(\d+)-/);
	return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

const ASSET_FILE = new RegExp(`^(${UUID_BODY})\\.[A-Za-z0-9]+$`);
// A bundled asset link as the exporter writes it: ../ steps up to a relative
// assets/ folder, the original asset id as the file name.
const BUNDLED_ASSET_LINK = new RegExp(`(?:\\.\\./)*assets/(${UUID_BODY})\\.[A-Za-z0-9]+`, 'g');

// Rewrites bundled asset links through the importer's old-id -> new-path map;
// a null mapping leaves the link untouched.
export function rewriteBundledAssetLinks(
	body: string,
	pathFor: (assetId: string) => string | null
): string {
	return body.replace(BUNDLED_ASSET_LINK, (link, assetId: string) => pathFor(assetId) ?? link);
}

export function parseStoryZip(bytes: Uint8Array): ImportPlan {
	let entries: Record<string, Uint8Array>;
	let count = 0;
	let total = 0;
	let skippedDrafts = false;
	try {
		entries = unzipSync(bytes, {
			filter(file) {
				// Saved drafts ride along in the story folder's drafts/; they are
				// not imported, so they do not count against the limits either.
				if (SAVED_DRAFT_PATH.test(file.name)) {
					skippedDrafts = true;
					return false;
				}
				if (++count > MAX_ENTRIES) {
					throw new StoryZipError('This archive has too many files to import.');
				}
				// fflate inflates to the declared size but copies stored entries
				// by their stored size, so count whichever is larger.
				const unpacked = Math.max(file.size, file.originalSize);
				if (unpacked > MAX_ENTRY_BYTES) {
					throw new StoryZipError('This archive contains a file that is too large to import.');
				}
				total += unpacked;
				if (total > MAX_TOTAL_BYTES) {
					throw new StoryZipError('This archive is too large to import once unpacked.');
				}
				return true;
			}
		});
	} catch (err) {
		if (err instanceof StoryZipError) throw err;
		throw new StoryZipError('This file is not a zip archive.');
	}

	// The export wraps everything in one folder named after the story; find
	// story.md (shallowest wins) and treat its folder as the root.
	const storyPath = Object.keys(entries)
		.filter((path) => path === 'story.md' || path.endsWith('/story.md'))
		.sort((a, b) => a.split('/').length - b.split('/').length)[0];
	if (!storyPath) {
		throw new StoryZipError('No story.md found; this is not a Codex story export.');
	}
	const root = storyPath.slice(0, storyPath.length - 'story.md'.length);
	const inRoot = (path: string) => (path.startsWith(root) ? path.slice(root.length) : null);

	const problems: string[] = [];
	if (skippedDrafts) {
		problems.push('The saved drafts in this archive were not imported, only the working draft.');
	}
	// An archive edited on Windows may carry \r\n line breaks; the editor and
	// the front matter parser count a line break as one \n.
	const read = (path: string) => toLf(strFromU8(entries[path]));

	const storyDoc = parseFrontMatter(read(storyPath));
	const story: ImportPlan['story'] = {
		title: scalar(storyDoc.fields, 'title') ?? deslug(root.replace(/\/$/, '')) ?? 'Imported story',
		author: scalar(storyDoc.fields, 'author'),
		brief: scalar(storyDoc.fields, 'brief'),
		descriptionMd: storyDoc.body.trim(),
		...(scalar(storyDoc.fields, 'adult') === 'true' && { isAdult: true }),
		...labelLists(storyDoc.fields),
		...assistantSettings(storyDoc.fields, problems)
	};
	if (!scalar(storyDoc.fields, 'title')) {
		problems.push(`story.md has no title; the story will be named "${story.title}".`);
	}

	const parseScene = (path: string, rel: string): ImportedScene => {
		const doc = parseFrontMatter(read(path));
		const rawStatus = scalar(doc.fields, 'status');
		let status: SceneStatus | null = null;
		if (rawStatus !== null) {
			if (isSceneStatus(rawStatus)) {
				status = rawStatus;
			} else {
				problems.push(`${rel}: unknown status "${rawStatus}"; the scene starts as a draft.`);
			}
		}
		return { title: scalar(doc.fields, 'title'), status, bodyMd: doc.body.trim() };
	};

	// Group chapter files by folder, ordered by the NN- prefix.
	const chapterFiles = new Map<string, { name: string; files: { path: string; file: string }[] }>();
	const unfiled: { path: string; file: string }[] = [];
	const notes: ImportedNote[] = [];
	const notebook: { rel: string; doc: ReturnType<typeof parseFrontMatter> }[] = [];
	const waiting: { rel: string; doc: ReturnType<typeof parseFrontMatter> }[] = [];
	const assets: ImportedAsset[] = [];

	for (const path of Object.keys(entries)) {
		const rel = inRoot(path);
		if (!rel || rel.endsWith('/')) continue;
		const parts = rel.split('/');
		if (parts[0] === 'chapters' && parts.length === 3 && parts[2].endsWith('.md')) {
			const group = chapterFiles.get(parts[1]) ?? { name: parts[1], files: [] };
			group.files.push({ path, file: parts[2] });
			chapterFiles.set(parts[1], group);
		} else if (parts[0] === 'unfiled' && parts.length === 2 && parts[1].endsWith('.md')) {
			unfiled.push({ path, file: parts[1] });
		} else if (
			parts[0] === 'notes' &&
			parts.length === 3 &&
			['characters', 'places', 'lore'].includes(parts[1]) &&
			parts[2].endsWith('.md')
		) {
			const doc = parseFrontMatter(read(path));
			const kind =
				parts[1] === 'characters' ? 'character' : parts[1] === 'places' ? 'place' : 'lore';
			const name = scalar(doc.fields, 'name');
			if (!name) {
				problems.push(`${rel}: the note names no entity and will be skipped.`);
				continue;
			}
			notes.push({ kind, name, notesMd: doc.body.trim() });
		} else if (parts[0] === 'notebook' && parts.length === 2 && parts[1].endsWith('.md')) {
			notebook.push({ rel, doc: parseFrontMatter(read(path)) });
		} else if (parts[0] === 'waiting-drafts' && parts.length === 2 && parts[1].endsWith('.md')) {
			waiting.push({ rel, doc: parseFrontMatter(read(path)) });
		} else if (parts[0] === 'assets' && parts.length === 2) {
			const match = parts[1].match(ASSET_FILE);
			if (match) assets.push({ id: match[1], path: parts[1], bytes: entries[path] });
		}
	}

	// Scene file path (as notebook front matter names it) -> plan position.
	const scenePositions = new Map<string, { chapter: number | null; index: number }>();

	const chapters = [...chapterFiles.values()]
		.sort((a, b) => orderOf(a.name) - orderOf(b.name) || a.name.localeCompare(b.name))
		.map((group, chapterIndex) => {
			const meta = group.files.find((f) => f.file === 'chapter.md');
			const title = meta
				? scalar(parseFrontMatter(read(meta.path)).fields, 'title')
				: deslug(group.name);
			const scenes = group.files
				.filter((f) => f.file !== 'chapter.md')
				.sort((a, b) => orderOf(a.file) - orderOf(b.file) || a.file.localeCompare(b.file))
				.map((f, index) => {
					const rel = `chapters/${group.name}/${f.file}`;
					scenePositions.set(rel, { chapter: chapterIndex, index });
					return parseScene(f.path, rel);
				});
			return { title, scenes };
		});

	const unfiledScenes = unfiled
		.sort((a, b) => orderOf(a.file) - orderOf(b.file) || a.file.localeCompare(b.file))
		.map((f, index) => {
			const rel = `unfiled/${f.file}`;
			scenePositions.set(rel, { chapter: null, index });
			return parseScene(f.path, rel);
		});

	const freeformNotes = notebook.map(({ rel, doc }): ImportedFreeformNote => {
		const scenePath = scalar(doc.fields, 'scene');
		const scene = scenePath ? (scenePositions.get(scenePath) ?? null) : null;
		if (scenePath && !scene) {
			problems.push(
				`${rel}: the scene ${scenePath} is not in this archive; the note stays on the story.`
			);
		}
		const created = scalar(doc.fields, 'created');
		const createdAt = created ? new Date(created) : null;
		return {
			title: scalar(doc.fields, 'title'),
			bodyMd: doc.body.trim(),
			pinned: scalar(doc.fields, 'pinned') === 'true',
			scene,
			createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null
		};
	});

	// A scene holds one waiting draft at a time; the first by file name wins.
	const drafted = new Set<string>();
	const waitingDrafts = waiting
		.sort((a, b) => a.rel.localeCompare(b.rel))
		.flatMap(({ rel, doc }): ImportedWaitingDraft[] => {
			const scenePath = scalar(doc.fields, 'scene');
			const scene = scenePath ? scenePositions.get(scenePath) : undefined;
			if (!scenePath || !scene) {
				problems.push(`${rel}: the draft's scene is not in this archive; the draft is skipped.`);
				return [];
			}
			if (drafted.has(scenePath)) {
				problems.push(`${rel}: ${scenePath} already has a waiting draft; this one is skipped.`);
				return [];
			}
			drafted.add(scenePath);
			const words = Number(scalar(doc.fields, 'words'));
			return [
				{
					scene,
					brief: scalar(doc.fields, 'brief') ?? '',
					targetWords: Number.isFinite(words) && words > 0 ? words : null,
					pov: scalar(doc.fields, 'pov'),
					note: scalar(doc.fields, 'note'),
					chapterBrief: scalar(doc.fields, 'chapter-brief'),
					source: scalar(doc.fields, 'source') === 'app' ? 'app' : 'assistant',
					textMd: doc.body.trim()
				}
			];
		});

	return {
		story,
		chapters,
		unfiled: unfiledScenes,
		notes,
		freeformNotes,
		waitingDrafts,
		assets,
		problems
	};
}
