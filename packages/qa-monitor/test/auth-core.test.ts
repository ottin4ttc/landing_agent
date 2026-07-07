import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/schema.ts";
import { createSession, getSession } from "../src/web/session-store.ts";
import { isAllowed } from "../src/web/whitelist.ts";

describe("isAllowed (fail-closed)", () => {
  it("empty whitelist rejects everyone", () => {
    expect(isAllowed([], "ou_1")).toBe(false);
  });
  it("rejects non-listed and empty openId, allows listed", () => {
    expect(isAllowed(["ou_1"], "ou_2")).toBe(false);
    expect(isAllowed(["ou_1"], null)).toBe(false);
    expect(isAllowed(["ou_1"], "")).toBe(false);
    expect(isAllowed(["ou_1"], "ou_1")).toBe(true);
  });
});

describe("session store", () => {
  it("creates and retrieves; expired returns null", () => {
    const db = openDb(":memory:");
    const sid = createSession(db, "ou_1", "张三", 1000, 100);
    expect(getSession(db, sid, 1050)).toEqual({ open_id: "ou_1", name: "张三" });
    expect(getSession(db, sid, 2000)).toBeNull(); // expired
    expect(getSession(db, "nope", 1050)).toBeNull();
    expect(getSession(db, undefined, 1050)).toBeNull();
  });
});
