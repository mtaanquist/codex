import { sql } from 'drizzle-orm';
import { CHAPTER_ROLES, CHAPTER_ROLE_LABELS } from '../chapter-role.ts';
import { chapters } from './db/schema.ts';

// A chapter's place among the story's regular chapters (chapterNumbers in SQL).
export const chapterOrdinal = sql<number>`(select count(*) from ${chapters} c2 where c2.story_id = ${chapters.storyId} and c2.position <= ${chapters.position} and c2.role is null)`;

const roleShown = sql.join(
	CHAPTER_ROLES.map((role) => sql`when ${role} then ${CHAPTER_ROLE_LABELS[role]}`),
	sql` `
);

// chapterLabel in SQL: the name a chapter shows, for selecting, searching and
// sorting by it.
export const chapterShown = sql<string>`(case when btrim(coalesce(${chapters.title}, ''), E' \\t\\n\\r') = '' then (case ${chapters.role} ${roleShown} else 'Chapter ' || ${chapterOrdinal} end) else ${chapters.title} end)`;
