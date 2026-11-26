import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgBoss } from 'pg-boss';
import { deleteLegacyQueues, LEGACY_QUEUES } from '../../src/worker/legacy-queues';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Worker startup deletes the queues the Assistant used before the v2 queues.
// It must get through whether those queues are still there or long gone.
let boss: PgBoss;

beforeAll(async () => {
	await ensureTestDatabase();
	boss = new PgBoss({ connectionString: TEST_DATABASE_URL, supervise: false, schedule: false });
	boss.on('error', (error) => console.error(error));
	await boss.start();
});

afterAll(async () => {
	await boss.stop({ graceful: false });
});

describe('deleteLegacyQueues', () => {
	it('deletes the old queues and their jobs when they are present', async () => {
		for (const queue of LEGACY_QUEUES) {
			await boss.createQueue(queue);
			await boss.send(queue, {});
		}
		await deleteLegacyQueues(boss);
		for (const queue of LEGACY_QUEUES) expect(await boss.getQueue(queue)).toBeNull();
	});

	it('does nothing when they are already gone', async () => {
		await expect(deleteLegacyQueues(boss)).resolves.toBeUndefined();
		await expect(deleteLegacyQueues(boss)).resolves.toBeUndefined();
	});

	it('keeps going past a queue that fails to delete', async () => {
		const deleted: string[] = [];
		await deleteLegacyQueues({
			deleteQueue: async (queue: string) => {
				if (queue === LEGACY_QUEUES[0]) throw new Error('boom');
				deleted.push(queue);
			}
		});
		expect(deleted).toEqual([LEGACY_QUEUES[1]]);
	});
});
