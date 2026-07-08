import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFileRefreshTokenStore } from "./file-refresh-store.js";

describe("createFileRefreshTokenStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "feishu-rt-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("文件不存在时 read 返回 null", () => {
    const store = createFileRefreshTokenStore(join(dir, "sub", "t.json"));
    expect(store.read()).toBeNull();
  });

  it("write 后 read 能取回，落 JSON，权限 0600", () => {
    const path = join(dir, "sub", "t.json");
    const store = createFileRefreshTokenStore(path);
    store.write("ref-abc");
    expect(store.read()).toBe("ref-abc");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.refresh_token).toBe("ref-abc");
    expect(typeof parsed.updated_at).toBe("number");
    // 权限低 6 位 == 600
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("write 覆盖旧值", () => {
    const path = join(dir, "t.json");
    const store = createFileRefreshTokenStore(path);
    store.write("first");
    store.write("second");
    expect(store.read()).toBe("second");
    expect(existsSync(`${path}.tmp`)).toBe(false); // 临时文件已 rename 掉
  });

  it("坏 JSON 时 read 返回 null 不抛", () => {
    const path = join(dir, "t.json");
    const store = createFileRefreshTokenStore(path);
    store.write("ok");
    // 手动写坏
    writeFileSync(path, "{not json");
    expect(store.read()).toBeNull();
  });
});
