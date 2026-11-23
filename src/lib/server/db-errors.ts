// Database error classification. Import-free (like queues.ts) so modules the
// worker uses can import it; db/index.ts reads $env and cannot be.

/** Whether a thrown database error is a unique-constraint violation, of the
 * named constraint or index when one is given. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
	const cause = (err as { cause?: { code?: string; constraint?: string } })?.cause;
	return cause?.code === '23505' && (constraint === undefined || cause.constraint === constraint);
}

/** Whether a thrown database error is a serialization failure (safe to retry). */
export function isSerializationFailure(err: unknown): boolean {
	return (err as { cause?: { code?: string } })?.cause?.code === '40001';
}

/** Whether a thrown database error is a foreign-key violation. */
export function isForeignKeyViolation(err: unknown): boolean {
	return (err as { cause?: { code?: string } })?.cause?.code === '23503';
}
