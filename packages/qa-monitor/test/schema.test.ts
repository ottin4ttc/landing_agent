import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/schema.ts";

describe("openDb", () => {
  it("creates qa_sessions and qa_admin_sessions tables", () => {
    const db = openDb(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("qa_sessions");
    expect(tables).toContain("qa_admin_sessions");
    const cols = db
      .prepare("PRAGMA table_info(qa_sessions)")
      .all()
      .map((r: any) => r.name);
    expect(cols).toContain("session_key");
    expect(cols).toContain("total_tokens");
    expect(cols).toContain("user_id");
  });
});
