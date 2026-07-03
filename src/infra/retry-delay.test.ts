// Tests shared retry delay arithmetic.
import { describe, expect, it } from "vitest";
import { computeExponentialRetryDelayMs } from "./retry-delay.js";

describe("computeExponentialRetryDelayMs", () => {
  it("uses one-based attempts and treats lower values as the first delay", () => {
    expect(computeExponentialRetryDelayMs(250, -1, 10_000)).toBe(250);
    expect(computeExponentialRetryDelayMs(250, 0, 10_000)).toBe(250);
    expect(computeExponentialRetryDelayMs(250, 1, 10_000)).toBe(250);
    expect(computeExponentialRetryDelayMs(250, 2, 10_000)).toBe(500);
  });

  it("caps exponential growth, including overflow", () => {
    expect(computeExponentialRetryDelayMs(250, 10, 1_000)).toBe(1_000);
    expect(computeExponentialRetryDelayMs(Number.MAX_VALUE, 2, 30_000)).toBe(30_000);
  });

  it("leaves uncapped delays unchanged", () => {
    expect(computeExponentialRetryDelayMs(125, 4)).toBe(1_000);
  });
});
