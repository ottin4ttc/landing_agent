import { afterEach, describe, expect, it } from "vitest";
import {
  appendSqliteSessionTranscriptEvent,
  loadSqliteSessionTranscriptEvents,
} from "../config/sessions/transcript-store.sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  prepareInternalSessionEffectsTranscript,
  removeInternalSessionEffectsTranscript,
  resolveInternalSessionEffectsTranscriptSessionId,
} from "./internal-session-effects.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
});

describe("prepareInternalSessionEffectsTranscript", () => {
  it("creates a private SQLite transcript even without a visible source", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      process.env.OPENCLAW_STATE_DIR = dir;

      const transcript = await prepareInternalSessionEffectsTranscript({
        agentId: "main",
        runId: "run/with space",
      });

      expect(transcript.sessionId).toBe("internal-agent-runs:run_with_space");
      expect(
        loadSqliteSessionTranscriptEvents({
          agentId: "main",
          sessionId: transcript.sessionId,
        }).map((entry) => entry.event),
      ).toEqual([]);

      await removeInternalSessionEffectsTranscript({
        agentId: "main",
        sessionId: transcript.sessionId,
      });
      expect(
        loadSqliteSessionTranscriptEvents({
          agentId: "main",
          sessionId: transcript.sessionId,
        }),
      ).toEqual([]);
    });
  });

  it("copies a visible source transcript into a private SQLite transcript", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      process.env.OPENCLAW_STATE_DIR = dir;
      appendSqliteSessionTranscriptEvent({
        agentId: "main",
        sessionId: "visible-session",
        event: { type: "session", id: "visible-session" },
      });
      appendSqliteSessionTranscriptEvent({
        agentId: "main",
        sessionId: "visible-session",
        event: {
          type: "message",
          id: "assistant-done",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
      });

      const transcript = await prepareInternalSessionEffectsTranscript({
        agentId: "main",
        sourceSessionId: "visible-session",
        runId: "run-copy",
      });

      expect(
        loadSqliteSessionTranscriptEvents({
          agentId: "main",
          sessionId: transcript.sessionId,
        }).map((entry) => entry.event),
      ).toEqual([
        { type: "session", id: "visible-session" },
        {
          type: "message",
          id: "assistant-done",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
      ]);
    });
  });

  it("creates an empty private transcript when the visible source is missing", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      process.env.OPENCLAW_STATE_DIR = dir;

      const transcript = await prepareInternalSessionEffectsTranscript({
        agentId: "main",
        sourceSessionId: "missing-session",
        runId: "run-missing-source",
      });

      expect(
        loadSqliteSessionTranscriptEvents({
          agentId: "main",
          sessionId: transcript.sessionId,
        }).map((entry) => entry.event),
      ).toEqual([]);
    });
  });

  it("resolves stable private transcript session ids", () => {
    expect(resolveInternalSessionEffectsTranscriptSessionId("run/with space")).toBe(
      "internal-agent-runs:run_with_space",
    );
  });
});
