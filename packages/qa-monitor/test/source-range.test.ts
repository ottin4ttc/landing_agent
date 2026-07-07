// landingAgent-specific (not upstream openclaw)
import { describe, it, expect } from "vitest";
import { usageDateRange } from "../src/collector/source.ts";

describe("usageDateRange", () => {
  it("computes a UTC [startDate, endDate] window spanning `days` days ending at nowMs", () => {
    // 2026-07-06T12:00:00Z
    const nowMs = Date.UTC(2026, 6, 6, 12, 0, 0);
    const { startDate, endDate } = usageDateRange(nowMs, 30);
    expect(endDate).toBe("2026-07-06");
    expect(startDate).toBe("2026-06-06");
  });

  it("handles days=1 (start == end minus 0 days, i.e. today only offset)", () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const { startDate, endDate } = usageDateRange(nowMs, 7);
    expect(endDate).toBe("2026-01-01");
    expect(startDate).toBe("2025-12-25");
  });
});
