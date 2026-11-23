import { describe, it, expect, beforeEach } from 'vitest';
import {
	rateLimit,
	refundSlidingRateLimit,
	resetRateLimits,
	slidingRateLimitKeys,
	slidingRateLimit,
	uploadLimit,
	writeLimit
} from './rate-limit';

beforeEach(() => resetRateLimits());

describe('rateLimit', () => {
	it('allows up to the limit, then blocks within the window', () => {
		const key = 'login:a@example.com';
		expect(rateLimit(key, 3, 1000, 0).allowed).toBe(true);
		expect(rateLimit(key, 3, 1000, 0).allowed).toBe(true);
		const third = rateLimit(key, 3, 1000, 0);
		expect(third.allowed).toBe(true);
		expect(third.remaining).toBe(0);

		const blocked = rateLimit(key, 3, 1000, 100);
		expect(blocked.allowed).toBe(false);
		expect(blocked.retryAfterSeconds).toBe(1); // 900ms left, rounded up
	});

	it('resets once the window has elapsed', () => {
		const key = 'reset:b@example.com';
		rateLimit(key, 1, 1000, 0);
		expect(rateLimit(key, 1, 1000, 500).allowed).toBe(false);
		expect(rateLimit(key, 1, 1000, 1000).allowed).toBe(true);
	});

	it('tracks keys independently', () => {
		expect(rateLimit('a', 1, 1000, 0).allowed).toBe(true);
		expect(rateLimit('a', 1, 1000, 0).allowed).toBe(false);
		expect(rateLimit('b', 1, 1000, 0).allowed).toBe(true);
	});
});

describe('slidingRateLimit', () => {
	it('forgets a key whose only call was refunded', () => {
		slidingRateLimit('calls:solo', 2, 1000, 0);
		refundSlidingRateLimit('calls:solo', 0);
		expect(slidingRateLimitKeys()).toBe(0);
		expect(slidingRateLimit('calls:solo', 1, 1000, 10).allowed).toBe(true);
	});

	it('gives back a refunded call, and only that one', () => {
		const key = 'calls:refund';
		expect(slidingRateLimit(key, 2, 1000, 0).allowed).toBe(true);
		expect(slidingRateLimit(key, 2, 1000, 100).allowed).toBe(true);
		expect(slidingRateLimit(key, 2, 1000, 200).allowed).toBe(false);
		refundSlidingRateLimit(key, 100);
		// A stamp that was never let through changes nothing.
		refundSlidingRateLimit(key, 200);
		refundSlidingRateLimit('calls:other', 0);
		expect(slidingRateLimit(key, 2, 1000, 300).allowed).toBe(true);
		expect(slidingRateLimit(key, 2, 1000, 400).allowed).toBe(false);
		// The call at 0 still counts until it is a window old.
		expect(slidingRateLimit(key, 2, 1000, 999).allowed).toBe(false);
		expect(slidingRateLimit(key, 2, 1000, 1000).allowed).toBe(true);
	});

	it('allows up to the limit, then blocks until the oldest call is a window old', () => {
		const key = 'calls:a';
		expect(slidingRateLimit(key, 2, 1000, 0).allowed).toBe(true);
		const second = slidingRateLimit(key, 2, 1000, 400);
		expect(second).toMatchObject({ allowed: true, remaining: 0 });
		const blocked = slidingRateLimit(key, 2, 1000, 500);
		expect(blocked).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
		expect(slidingRateLimit(key, 2, 1000, 999).allowed).toBe(false);
		expect(slidingRateLimit(key, 2, 1000, 1000).allowed).toBe(true);
		// The call at 400 still counts.
		expect(slidingRateLimit(key, 2, 1000, 1100).allowed).toBe(false);
		expect(slidingRateLimit(key, 2, 1000, 1400).allowed).toBe(true);
	});

	it('never lets more than the limit through in any stretch of the window, unlike a fixed one', () => {
		// The whole limit at the end of one minute and again at the start of the
		// next: a fixed window allows both bursts.
		const burst = (limiter: typeof rateLimit, at: number) =>
			Array.from({ length: 10 }, () => limiter('edge', 10, 1000, at)).filter(
				(result) => result.allowed
			).length;
		expect(burst(rateLimit, 0)).toBe(10);
		expect(burst(rateLimit, 990) + burst(rateLimit, 1010)).toBe(10);
		resetRateLimits();
		expect(burst(slidingRateLimit, 990)).toBe(10);
		expect(burst(slidingRateLimit, 1010)).toBe(0);
		expect(burst(slidingRateLimit, 1990)).toBe(10);
	});

	it('does not count a refused call, tracks keys apart, and is cleared with the rest', () => {
		expect(slidingRateLimit('a', 1, 1000, 0).allowed).toBe(true);
		for (let at = 100; at < 1000; at += 100) {
			expect(slidingRateLimit('a', 1, 1000, at).allowed).toBe(false);
		}
		expect(slidingRateLimit('a', 1, 1000, 1000).allowed).toBe(true);
		expect(slidingRateLimit('b', 1, 1000, 1000).allowed).toBe(true);
		resetRateLimits();
		expect(slidingRateLimit('a', 1, 1000, 1001).allowed).toBe(true);
	});

	it('does not hold a key shut when the clock is set back', () => {
		const HOUR = 3600 * 1000;
		const at = 10 * HOUR;
		expect(slidingRateLimit('back', 2, 60_000, at).allowed).toBe(true);
		expect(slidingRateLimit('back', 2, 60_000, at + 10).allowed).toBe(true);
		expect(slidingRateLimit('back', 2, 60_000, at + 20).allowed).toBe(false);
		// The clock steps back an hour: the calls stamped "later" are no guide.
		const stepped = slidingRateLimit('back', 2, 60_000, at - HOUR);
		expect(stepped.allowed).toBe(true);
		// And the limit holds from there as before.
		expect(slidingRateLimit('back', 2, 60_000, at - HOUR + 10).allowed).toBe(true);
		const refused = slidingRateLimit('back', 2, 60_000, at - HOUR + 20);
		expect(refused.allowed).toBe(false);
		expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
	});
});

describe('write and upload budgets', () => {
	it('keeps the write and upload budgets in separate buckets per user', () => {
		// A user's uploads do not draw down their (much larger) write budget.
		expect(writeLimit('u1', 0).allowed).toBe(true);
		expect(uploadLimit('u1', 0).allowed).toBe(true);
		expect(writeLimit('u1', 0).remaining).toBeGreaterThan(uploadLimit('u1', 0).remaining);
	});

	it('limits one user without affecting another', () => {
		// Spend u1's upload budget; u2 is untouched.
		let last = uploadLimit('u1', 0);
		for (let i = 0; i < 200 && last.allowed; i++) last = uploadLimit('u1', 0);
		expect(last.allowed).toBe(false);
		expect(uploadLimit('u2', 0).allowed).toBe(true);
	});
});
