import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { hasProcessedFeishuMessage, testingHooks } from "./dedup.js";
import { detectFeishuLegacyStateMigrations } from "./doctor-legacy-state.js";
import { setFeishuRuntime } from "./runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  testingHooks.resetFeishuDedupForTests();
  resetPluginStateStoreForTests();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-feishu-migrate-"));
  tempDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  setFeishuRuntime({
    state: {
      openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateSyncKeyedStoreForTests("feishu", options),
    },
  } as unknown as PluginRuntime);
  return stateDir;
}

describe("Feishu legacy state migrations", () => {
  it("imports dedupe cache rows into plugin state and removes JSON files", async () => {
    const stateDir = makeStateDir();
    const dedupDir = path.join(stateDir, "feishu", "dedup");
    fs.mkdirSync(dedupDir, { recursive: true });
    const sourcePath = path.join(dedupDir, "work.json");
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        "msg-1": Date.now(),
      })}\n`,
    );

    const plan = detectFeishuLegacyStateMigrations({ stateDir })[0];
    if (!plan || plan.kind !== "custom") {
      throw new Error("missing Feishu dedupe migration plan");
    }
    const result = await plan.apply({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
    });

    expect(result.changes.join("\n")).toContain("Imported 1 Feishu dedupe cache");
    testingHooks.resetFeishuDedupMemoryForTests();
    await expect(hasProcessedFeishuMessage("msg-1", "work")).resolves.toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });
});
