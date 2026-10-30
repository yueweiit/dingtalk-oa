interface ReadRateLimits {
  requestsPerMinute: number;
  totalRequestsPerMinute: number;
  now: () => number;
  maxSources?: number;
}

/** Source budgets include invalid requests; only admitted queries consume the total budget. */
export function createReadRateLimiter(options: ReadRateLimits) {
  const sources = new Map<string, number>();
  const maxSources = options.maxSources ?? 10_000;
  let sourceResetAt = 0;
  let totalResetAt = 0;
  let totalCount = 0;
  const retryAfter = (resetAt: number, now: number) => Math.max(1, Math.ceil((resetAt - now) / 1000));

  return {
    source(ip: string): number | undefined {
      const now = options.now();
      if (now >= sourceResetAt) {
        sources.clear();
        sourceResetAt = now + 60_000;
      }
      const count = sources.get(ip) ?? 0;
      if (count >= options.requestsPerMinute || (!sources.has(ip) && sources.size >= maxSources)) {
        return retryAfter(sourceResetAt, now);
      }
      sources.set(ip, count + 1);
      return undefined;
    },
    query(): number | undefined {
      const now = options.now();
      if (now >= totalResetAt) {
        totalCount = 0;
        totalResetAt = now + 60_000;
      }
      if (totalCount >= options.totalRequestsPerMinute) return retryAfter(totalResetAt, now);
      totalCount++;
      return undefined;
    },
  };
}
