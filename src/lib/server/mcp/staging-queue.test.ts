import { describe, expect, it } from 'vitest';
import { inStagingTurn, StagingBusyError } from './staging-queue';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('inStagingTurn', () => {
	it('runs calls with one key one at a time, in the order they came', async () => {
		const log: string[] = [];
		const work = (name: string, ms: number) => async () => {
			log.push(`${name} in`);
			await pause(ms);
			log.push(`${name} out`);
			return name;
		};
		const results = await Promise.all([
			inStagingTurn('a', work('one', 20)),
			inStagingTurn('a', work('two', 1)),
			inStagingTurn('a', work('three', 1))
		]);
		expect(results).toEqual(['one', 'two', 'three']);
		expect(log).toEqual(['one in', 'one out', 'two in', 'two out', 'three in', 'three out']);
	});

	it('does not hold one key back for another', async () => {
		const log: string[] = [];
		await Promise.all([
			inStagingTurn('a', async () => {
				await pause(20);
				log.push('a');
			}),
			inStagingTurn('b', async () => {
				log.push('b');
			})
		]);
		expect(log).toEqual(['b', 'a']);
	});

	it('turns away a call when the line is full, and takes calls again once it clears', async () => {
		const slow = () => pause(20);
		const calls = [1, 2, 3, 4].map(() => inStagingTurn('a', slow, { waiting: 2 }));
		const outcomes = await Promise.allSettled(calls);
		expect(outcomes.map((outcome) => outcome.status)).toEqual([
			'fulfilled',
			'fulfilled',
			'fulfilled',
			'rejected'
		]);
		expect((outcomes[3] as PromiseRejectedResult).reason).toBeInstanceOf(StagingBusyError);
		await expect(inStagingTurn('a', async () => 'again', { waiting: 0 })).resolves.toBe('again');
	});

	it('lets the next call run after one that failed', async () => {
		const failing = inStagingTurn('a', async () => {
			throw new Error('no');
		});
		const next = inStagingTurn('a', async () => 'next');
		await expect(failing).rejects.toThrow('no');
		await expect(next).resolves.toBe('next');
	});

	it('runs only so many calls at once over every key, and the rest in turn', async () => {
		let now = 0;
		let most = 0;
		const work = async () => {
			most = Math.max(most, ++now);
			await pause(15);
			now -= 1;
		};
		await Promise.all(
			['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) => inStagingTurn(key, work, { running: 2 }))
		);
		expect(most).toBe(2);
		expect(now).toBe(0);
	});

	it('gives up when its turn has not come by the deadline, without jumping the line', async () => {
		const log: string[] = [];
		const long = inStagingTurn('a', async () => {
			await pause(80);
			log.push('long out');
		});
		const impatient = inStagingTurn('a', async () => log.push('impatient ran'), { waitMs: 20 });
		const patient = inStagingTurn('a', async () => log.push('patient in'));
		await expect(impatient).rejects.toBeInstanceOf(StagingBusyError);
		// The call that gave up left while the first was still running; the one
		// behind it still waits for the first.
		expect(log).toEqual([]);
		await Promise.all([long, patient]);
		expect(log).toEqual(['long out', 'patient in']);
	});

	it('gives up waiting for a free slot at the deadline, and leaves the slots in order', async () => {
		const holding = inStagingTurn('a', () => pause(60), { running: 1 });
		await expect(
			inStagingTurn('b', async () => 'ran', { running: 1, waitMs: 15 })
		).rejects.toBeInstanceOf(StagingBusyError);
		await holding;
		await expect(inStagingTurn('b', async () => 'ran', { running: 1 })).resolves.toBe('ran');
	});
});
