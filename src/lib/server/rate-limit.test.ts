import { describe, it, expect, beforeEach } from 'vitest';
import {
	rateLimit,
	resetRateLimits,
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
