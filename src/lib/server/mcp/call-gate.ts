import {
	MAX_READ_CALLS_PER_WRITER,
	MAX_READ_CALLS_RUNNING,
	MAX_READ_CALLS_WAITING,
	MAX_STAGING_CALLS_WAITING,
	MAX_STAGING_TRANSACTIONS,
	READ_WAIT_TIMEOUT_MS,
	STAGING_WAIT_TIMEOUT_MS
} from './constants.ts';

// How many calls from outside apps run at once. A call that has to wait does
// so here, in memory, before it takes a database connection: waiting inside
// the database would pin a pooled connection for each waiting call, and the
// pool is small and shared with every page and save of every writer.
//
// A gate lets each writer run a few calls at a time, whichever of their apps
// and tokens sent them, and a few more in the whole process. When a place
// comes free it goes to the writer who has waited longest for a turn, not to
// the call that came first, so one writer's long line does not hold up
// another's call. Within one writer, calls run in the order they came.
//
// The app runs as one process (rate-limit.ts relies on the same), so
// module-level state is enough.

export class GateBusyError extends Error {
	constructor() {
		super('Too many calls at once. Try again');
	}
}

export type GateLimits = {
	// Calls of one writer that may run at once.
	perWriter: number;
	// Calls that may run at once, over every writer.
	total: number;
	// Calls of one writer that may wait for a place.
	waiting: number;
	// The longest a call waits before it gives up.
	waitMs: number;
};

export type CallGate = {
	// Runs `work` when the writer has a place, telling it whether it had to
	// wait for one (and so whether what it checked before may have changed).
	// Throws GateBusyError at once when the writer's line is full, and at the
	// deadline when no place came.
	run<T>(writer: string, work: (waited: boolean) => Promise<T>): Promise<T>;
};

export function createCallGate(limits: GateLimits): CallGate {
	let running = 0;
	const runningBy = new Map<string, number>();
	// Each writer's waiting calls, oldest first. The map keeps the writers in
	// the order they should next be served: one who is given a place goes to
	// the back.
	const lines = new Map<string, (() => void)[]>();

	const mayRun = (writer: string) => (runningBy.get(writer) ?? 0) < limits.perWriter;
	function take(writer: string): void {
		running += 1;
		runningBy.set(writer, (runningBy.get(writer) ?? 0) + 1);
	}
	function admit(): void {
		while (running < limits.total) {
			let served: string | undefined;
			for (const writer of lines.keys()) {
				if (mayRun(writer)) {
					served = writer;
					break;
				}
			}
			if (served === undefined) return;
			const line = lines.get(served)!;
			const start = line.shift()!;
			lines.delete(served);
			if (line.length > 0) lines.set(served, line);
			take(served);
			start();
		}
	}

	return {
		async run(writer, work) {
			const line = lines.get(writer);
			const waited = !(!line && mayRun(writer) && running < limits.total);
			if (!waited) {
				take(writer);
			} else {
				if ((line?.length ?? 0) >= limits.waiting) throw new GateBusyError();
				await new Promise<void>((resolve, reject) => {
					const start = () => {
						clearTimeout(timer);
						resolve();
					};
					const timer = setTimeout(() => {
						const waitingNow = lines.get(writer);
						if (waitingNow) {
							waitingNow.splice(waitingNow.indexOf(start), 1);
							if (waitingNow.length === 0) lines.delete(writer);
						}
						reject(new GateBusyError());
					}, limits.waitMs);
					const mine = lines.get(writer) ?? [];
					mine.push(start);
					lines.set(writer, mine);
				});
			}
			try {
				return await work(waited);
			} finally {
				running -= 1;
				const left = (runningBy.get(writer) ?? 1) - 1;
				if (left > 0) runningBy.set(writer, left);
				else runningBy.delete(writer);
				admit();
			}
		}
	};
}

// Calls that stage something. One at a time for a writer: each checks before
// it writes (a repeat, a ceiling, whose turn it is), and each holds the lock
// a save of the scene waits on, so calls side by side would both pass the
// check and keep the writer's own save waiting.
export const stagingGate = createCallGate({
	perWriter: 1,
	total: MAX_STAGING_TRANSACTIONS,
	waiting: MAX_STAGING_CALLS_WAITING,
	waitMs: STAGING_WAIT_TIMEOUT_MS
});

// Calls that only read. They have places of their own, so reading cannot
// keep staging waiting or the other way round.
export const readGate = createCallGate({
	perWriter: MAX_READ_CALLS_PER_WRITER,
	total: MAX_READ_CALLS_RUNNING,
	waiting: MAX_READ_CALLS_WAITING,
	waitMs: READ_WAIT_TIMEOUT_MS
});

// The advisory lock a staging call takes inside its transaction: the same
// rule as the staging gate, kept by the database, should more than one
// process ever serve a writer.
export const stagingKey = (userId: string) => `mcp-staging:${userId}`;
