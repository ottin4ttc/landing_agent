// Computes retry delay arithmetic without owning retry policy or scheduling.

/** Computes a 1-based exponential retry delay with an optional hard cap. */
export function computeExponentialRetryDelayMs(
  baseDelayMs: number,
  attempt: number,
  maxDelayMs = Number.POSITIVE_INFINITY,
): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(attempt - 1, 0));
}
