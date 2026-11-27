// Front and back matter: a chapter can be marked as a dedication, a
// prologue, and so on. A chapter with no role is a regular chapter, and only
// regular chapters are numbered ("Chapter 3" is the third regular chapter).
// The writer's order is kept as it is; a role never moves a chapter.
export const CHAPTER_ROLES = [
	'dedication',
	'foreword',
	'prologue',
	'epilogue',
	'afterword',
	'acknowledgements',
	'authors_note'
] as const;

export type ChapterRole = (typeof CHAPTER_ROLES)[number];

export const CHAPTER_ROLE_LABELS: Record<ChapterRole, string> = {
	dedication: 'Dedication',
	foreword: 'Foreword',
	prologue: 'Prologue',
	epilogue: 'Epilogue',
	afterword: 'Afterword',
	acknowledgements: 'Acknowledgements',
	authors_note: "Author's note"
};

// The type a chapter with no role has, as the chapter menu names it.
export const REGULAR_CHAPTER_LABEL = 'Regular chapter';

export function isChapterRole(value: unknown): value is ChapterRole {
	return typeof value === 'string' && (CHAPTER_ROLES as readonly string[]).includes(value);
}

// Reads a stored or imported role: anything that is not a known role (an
// edition saved before roles, a hand-edited chapter.md) is a regular chapter.
export function chapterRoleOf(value: unknown): ChapterRole | null {
	return isChapterRole(value) ? value : null;
}

// The name of a chapter's type: its role, or a regular chapter.
export function chapterTypeLabel(value: unknown): string {
	const role = chapterRoleOf(value);
	return role ? CHAPTER_ROLE_LABELS[role] : REGULAR_CHAPTER_LABEL;
}

type LabelledChapter = { title: string | null; role?: string | null };

// Each chapter's number among the regular chapters, null for a role chapter.
export function chapterNumbers(chapters: readonly LabelledChapter[]): (number | null)[] {
	let count = 0;
	return chapters.map((chapter) => (chapterRoleOf(chapter.role) ? null : ++count));
}

// The name a chapter shows: its title, else its role, else "Chapter N".
export function chapterLabel(chapter: LabelledChapter, number: number | null): string {
	const title = chapter.title?.trim();
	if (title) return title;
	const role = chapterRoleOf(chapter.role);
	if (role) return CHAPTER_ROLE_LABELS[role];
	return `Chapter ${number ?? 1}`;
}

// The shown name of every chapter in a story, in the order given.
export function chapterLabels(chapters: readonly LabelledChapter[]): string[] {
	const numbers = chapterNumbers(chapters);
	return chapters.map((chapter, index) => chapterLabel(chapter, numbers[index]));
}
