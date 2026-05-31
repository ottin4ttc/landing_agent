import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendAssistantMessageToRuntimeSession,
  openRuntimeSessionHandle,
} from "./runtime-session-handle.js";
import { upsertSessionEntry } from "./store.js";
import { loadSqliteSessionTranscriptEvents } from "./transcript-store.sqlite.js";

async function useTempStateDir(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-session-handle-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("RuntimeSessionHandle", () => {
  it("resolves a session key to the canonical session id before appending transcript events", async () => {
    await useTempStateDir();
    upsertSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:discord",
      entry: {
        sessionId: "session-123",
        chatType: "direct",
        channel: "discord",
        updatedAt: 1,
      },
    });

    const handle = await openRuntimeSessionHandle({
      agentId: "main",
      sessionKey: "agent:main:discord",
    });

    expect(handle).toMatchObject({
      agentId: "main",
      sessionId: "session-123",
      sessionKey: "agent:main:discord",
    });
    expect(handle).not.toHaveProperty("sessionFile");

    await appendAssistantMessageToRuntimeSession({
      handle: handle!,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello via handle" }],
        api: "openai-responses",
        provider: "openclaw",
        model: "delivery-mirror",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    });

    const events = loadSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: "session-123",
    }).map((entry) => entry.event as { type?: string; message?: { role?: string } });
    expect(events).toMatchObject([
      { type: "session" },
      { type: "message", message: { role: "assistant" } },
    ]);
  });
});
