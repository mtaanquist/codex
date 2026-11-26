import type { PgBoss } from 'pg-boss';
import { errorFields, logEvent } from '../lib/server/log.ts';

// The review and summaries queues used before #986, and drained until #1041.
// Nothing reads them now; deleting a queue that is already gone does nothing.
export const LEGACY_QUEUES = ['assistant-review', 'assistant-summaries'] as const;

// A failure here is only logged: the cleanup is retried on the next start, and
// must not keep the worker from starting or the other queue from going.
export async function deleteLegacyQueues(
	boss: Pick<PgBoss, 'deleteQueue'>,
	queues: readonly string[] = LEGACY_QUEUES
): Promise<void> {
	for (const queue of queues) {
		try {
			await boss.deleteQueue(queue);
		} catch (err) {
			logEvent('warn', 'worker.legacy_queue_cleanup_failed', { queue, ...errorFields(err) });
		}
	}
}
