/** A LIKE pattern matching text that contains `find` as it is, with LIKE's
 * own wildcards in it escaped. */
export function likePattern(find: string): string {
	return `%${find.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
