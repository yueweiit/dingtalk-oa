import { describe, expect, it } from 'vitest';
import { createReadRateLimiter } from './rate-limit.js';

describe('read API limiter state', () => {
  it('bounds tracked sources without evicting active callers, and reclaims them next minute', () => {
    let now = 0;
    const limiter = createReadRateLimiter({ requestsPerMinute: 2, totalRequestsPerMinute: 3, maxSources: 2, now: () => now });
    expect(limiter.source('a')).toBeUndefined();
    expect(limiter.source('b')).toBeUndefined();
    expect(limiter.source('c')).toBe(60);
    expect(limiter.source('a')).toBeUndefined();
    expect(limiter.source('a')).toBe(60);
    now = 59_500;
    expect(limiter.source('c')).toBe(1);
    now = 60_000;
    expect(limiter.source('c')).toBeUndefined();
    expect(limiter.source('a')).toBeUndefined();
  });
});
