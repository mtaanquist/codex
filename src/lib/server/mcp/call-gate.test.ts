import { describe, expect, it } from 'vitest';
import { createCallGate, GateBusyError, type GateLimits } from './call-gate';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const gateWith = (limits: Partial<GateLimits> = {}) =>
	createCallGate({ perWriter: 1, total: 3, waiting: 8, waitMs: 5000, ...limits });

describe('a call gate', () => {
	it('runs one writers calls one at a time, in the order they came', async () => {
		const gate = gateWith();
		const log: string[] = [];
		const work = (name: string, ms: number) => async () => {
			log.push(`${name} in`);
			await pause(ms);
			log.push(`${name} out`);
			return name;
		};
		const results = await Promise.all([
			gate.run('a', work('one', 20)),
			gate.run('a', work('two', 1)),
			gate.run('a', work('three', 1))
		]);
		expect(results).toEqual(['one', 'two', 'three']);
		expect(log).toEqual(['one in', 'one out', 'two in', 'two out', 'three in', 'three out']);
	});

	it('lets a writer run as many at once as the gate allows, and no more', async () => {
		const gate = gateWith({ perWriter: 2 });
		let now = 0;
		let most = 0;
		const work = async () => {
			most = Math.max(most, ++now);
			await pause(10);
			now -= 1;
		};
		await Promise.all(Array.from({ length: 6 }, () => gate.run('a', work)));
		expect(most).toBe(2);
	});

	it('does not hold one writer back for another', async () => {
		const gate = gateWith();
		const log: string[] = [];
		await Promise.all([
			gate.run('a', async () => {
				await pause(20);
				log.push('a');
			}),
			gate.run('b', async () => {
				log.push('b');
			})
		]);
		expect(log).toEqual(['b', 'a']);
	});

	it('turns away a call when the writers line is full, and takes calls again once it clears', async () => {
		const gate = gateWith({ waiting: 2 });
		const outcomes = await Promise.allSettled(
			[1, 2, 3, 4].map(() => gate.run('a', () => pause(20)))
		);
		expect(outcomes.map((outcome) => outcome.status)).toEqual([
			'fulfilled',
			'fulfilled',
			'fulfilled',
			'rejected'
		]);
		expect((outcomes[3] as PromiseRejectedResult).reason).toBeInstanceOf(GateBusyError);
		await expect(gate.run('a', async () => 'again')).resolves.toBe('again');
	});

	it('lets the next call run after one that failed', async () => {
		const gate = gateWith();
		const failing = gate.run('a', async () => {
			throw new Error('no');
		});
		const next = gate.run('a', async () => 'next');
		await expect(failing).rejects.toThrow('no');
		await expect(next).resolves.toBe('next');
	});

	it('runs only so many calls at once over every writer', async () => {
		const gate = gateWith({ total: 2 });
		let now = 0;
		let most = 0;
		const work = async () => {
			most = Math.max(most, ++now);
			await pause(15);
			now -= 1;
		};
		await Promise.all(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((writer) => gate.run(writer, work)));
		expect(most).toBe(2);
		expect(now).toBe(0);
	});

	it('gives a free place to the writer who has not had a turn, not to the longest line', async () => {
		const gate = gateWith({ total: 1 });
		const log: string[] = [];
		const work = (name: string) => async () => {
			await pause(5);
			log.push(name);
		};
		// One writer lines up four calls before another writer sends one.
		const calls = [
			gate.run('greedy', work('greedy 1')),
			gate.run('greedy', work('greedy 2')),
			gate.run('greedy', work('greedy 3')),
			gate.run('greedy', work('greedy 4')),
			gate.run('other', work('other 1'))
		];
		await Promise.all(calls);
		expect(log).toEqual(['greedy 1', 'greedy 2', 'other 1', 'greedy 3', 'greedy 4']);
	});

	it('gives up at the deadline without jumping the line, and leaves the places in order', async () => {
		const gate = createCallGate({ perWriter: 1, total: 3, waiting: 8, waitMs: 20 });
		const log: string[] = [];
		const long = gate.run('a', async () => {
			await pause(60);
			log.push('long out');
		});
		await expect(gate.run('a', async () => log.push('impatient ran'))).rejects.toBeInstanceOf(
			GateBusyError
		);
		expect(log).toEqual([]);
		await long;
		await expect(gate.run('a', async () => 'after')).resolves.toBe('after');
		expect(log).toEqual(['long out']);
	});
});
