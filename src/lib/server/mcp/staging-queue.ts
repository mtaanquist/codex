import {
	MAX_STAGING_CALLS_WAITING,
	MAX_STAGING_TRANSACTIONS,
	STAGING_WAIT_TIMEOUT_MS
} from './constants.ts';

// The staging calls made for one writer in one universe run one at a time,
// whichever of the writer's apps and tokens they come from, and the ones that
// wait do so here, in memory, before they take a database connection. Waiting
// on a lock inside the database would pin a pooled connection for each
// waiting call, and each call that ran beside another would make the writer's
// own save of a scene wait behind both. On top of that only a few staging
// calls run at once in the whole process, so many writers' apps together
// leave most of the pool to everything else. The app runs as one process
// (rate-limit.ts relies on the same), so module-level state is enough; the
// advisory lock the caller takes inside its transaction still orders calls
// if that ever stops being true.

export const stagingKey = (userId: string, universeId: string) =>
	`mcp-staging:${userId}:${universeId}`;

export class StagingBusyError extends Error {
	constructor() {
		super('Another call is still running. Try again');
	}
}

export type StagingLimits = {
	// Calls that may wait behind the one running with the same key.
	waiting: number;
	// Calls that may run at once, over every key.
	running: number;
	// The longest a call waits for its turn before it gives up.
	waitMs: number;
};

const DEFAULTS: StagingLimits = {
	waiting: MAX_STAGING_CALLS_WAITING,
	running: MAX_STAGING_TRANSACTIONS,
	waitMs: STAGING_WAIT_TIMEOUT_MS
};

type Line = { tail: Promise<void>; size: number };
const lines = new Map<string, Line>();

let running = 0;
const slotWaiters: (() => void)[] = [];

// Resolves when `turn` does; rejects with StagingBusyError at the deadline.
function byDeadline(turn: Promise<void>, deadline: number, abandon?: () => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => {
				abandon?.();
				reject(new StagingBusyError());
			},
			Math.max(0, deadline - Date.now())
		);
		void turn.then(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}

async function takeSlot(limit: number, deadline: number): Promise<void> {
	if (running < limit) {
		running += 1;
		return;
	}
	let granted!: () => void;
	const turn = new Promise<void>((resolve) => (granted = resolve));
	slotWaiters.push(granted);
	// A slot handed over keeps its count; a call that gives up leaves the line.
	await byDeadline(turn, deadline, () => {
		slotWaiters.splice(slotWaiters.indexOf(granted), 1);
	});
}

function freeSlot(): void {
	const next = slotWaiters.shift();
	if (next) next();
	else running -= 1;
}

// Runs `work` after every earlier call with the same key has finished, and
// once fewer than `limits.running` calls are running in all. Throws
// StagingBusyError without waiting when the line for the key is full, and at
// the deadline when its turn has not come.
export async function inStagingTurn<T>(
	key: string,
	work: () => Promise<T>,
	limits: Partial<StagingLimits> = {}
): Promise<T> {
	const { waiting, running: slots, waitMs } = { ...DEFAULTS, ...limits };
	const line = lines.get(key) ?? { tail: Promise.resolve(), size: 0 };
	if (line.size > waiting) throw new StagingBusyError();
	lines.set(key, line);
	line.size += 1;
	const before = line.tail;
	let finished!: () => void;
	line.tail = new Promise<void>((resolve) => (finished = resolve));
	const deadline = Date.now() + waitMs;
	try {
		await byDeadline(before, deadline);
		await takeSlot(slots, deadline);
		try {
			return await work();
		} finally {
			freeSlot();
		}
	} finally {
		// The turn passes on only when the calls ahead have finished, also for
		// a call that gave up waiting, so the next never runs beside them.
		void before.then(finished);
		line.size -= 1;
		if (line.size === 0) lines.delete(key);
	}
}
