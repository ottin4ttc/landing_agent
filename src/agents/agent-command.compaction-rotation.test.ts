import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

// SQLite-backed session store stand-in. The rotation flow drives the real
// agentCommand persistence path; we back getSessionEntry/upsertSessionEntry/
// patchSessionEntry/listSessionEntries with this in-memory map instead of an
// on-disk session-entries.sqlite database so the test stays hermetic.
const state = vi.hoisted(() => ({
  cfg: undefined as OpenClawConfig | undefined,
  workspaceDir: undefined as string | undefined,
  agentDir: undefined as string | undefined,
  runAgentAttemptMock: vi.fn(),
  deliveryFreshEntries: [] as Array<SessionEntry | undefined>,
  sessionRows: new Map<string, SessionEntry>(),
}));

function cloneEntry(entry: SessionEntry): SessionEntry {
  return structuredClone(entry);
}

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => state.cfg,
  readConfigFileSnapshotForWrite: async () => ({ snapshot: { valid: false } }),
}));

// Override only the SQLite session-row accessors; keep the rest of the barrel
// (mergeSessionEntry, setSessionRuntimeModel, key helpers) real so the
// rotation merge logic runs against the production implementation.
vi.mock("../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../config/sessions.js")>(
    "../config/sessions.js",
  );
  return {
    ...actual,
    getSessionEntry: ({ sessionKey }: { sessionKey: string }) => {
      const entry = state.sessionRows.get(sessionKey);
      return entry ? cloneEntry(entry) : undefined;
    },
    upsertSessionEntry: ({ sessionKey, entry }: { sessionKey: string; entry: SessionEntry }) => {
      state.sessionRows.set(sessionKey, cloneEntry(entry));
    },
  };
});

vi.mock("../config/sessions/store.js", async () => {
  const actual = await vi.importActual<typeof import("../config/sessions/store.js")>(
    "../config/sessions/store.js",
  );
  return {
    ...actual,
    getSessionEntry: ({ sessionKey }: { sessionKey: string }) => {
      const entry = state.sessionRows.get(sessionKey);
      return entry ? cloneEntry(entry) : undefined;
    },
    upsertSessionEntry: ({ sessionKey, entry }: { sessionKey: string; entry: SessionEntry }) => {
      state.sessionRows.set(sessionKey, cloneEntry(entry));
    },
    listSessionEntries: () =>
      Array.from(state.sessionRows.entries()).map(([sessionKey, entry]) => ({
        sessionKey,
        entry: cloneEntry(entry),
      })),
    patchSessionEntry: async (params: {
      sessionKey: string;
      fallbackEntry?: SessionEntry;
      update: (entry: SessionEntry) => unknown;
    }) => {
      const existing = state.sessionRows.get(params.sessionKey) ?? params.fallbackEntry;
      if (!existing) {
        return null;
      }
      // attempt-execution.shared returns an already-merged entry from update();
      // keep the existing row when update() opts out (returns null).
      const result = await params.update(cloneEntry(existing));
      if (!result) {
        return state.sessionRows.get(params.sessionKey) ?? null;
      }
      const next = ((result as { patch?: Partial<SessionEntry> }).patch ??
        result) as SessionEntry;
      state.sessionRows.set(params.sessionKey, cloneEntry(next));
      return cloneEntry(next);
    },
  };
});

// Session routing metadata lives in SQLite; the rotation test never exercises
// channel routing, so return no routing info.
vi.mock("../config/sessions/session-entries.sqlite.js", async () => {
  const actual = await vi.importActual<
    typeof import("../config/sessions/session-entries.sqlite.js")
  >("../config/sessions/session-entries.sqlite.js");
  return {
    ...actual,
    readSqliteSessionRoutingInfo: () => undefined,
  };
});

vi.mock("./agent-runtime-config.js", () => ({
  resolveAgentRuntimeConfig: async () => ({
    loadedRaw: state.cfg,
    sourceConfig: state.cfg,
    cfg: state.cfg,
  }),
}));

vi.mock("./agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
  return {
    ...actual,
    clearAutoFallbackPrimaryProbeSelection: vi.fn(),
    entryMatchesAutoFallbackPrimaryProbe: () => false,
    hasSessionAutoModelFallbackProvenance: () => false,
    listAgentIds: () => ["main"],
    markAutoFallbackPrimaryProbe: vi.fn(),
    resolveAutoFallbackPrimaryProbe: () => undefined,
    resolveAgentConfig: () => undefined,
    resolveAgentDir: () => state.agentDir ?? "/tmp/openclaw-agent",
    resolveDefaultAgentId: () => "main",
    resolveEffectiveModelFallbacks: () => undefined,
    resolveSessionAgentId: () => "main",
    resolveAgentWorkspaceDir: () => state.workspaceDir ?? "/tmp/openclaw-workspace",
  };
});

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: () => ({ plugins: [] }),
}));

vi.mock("./model-catalog.js", () => ({
  loadManifestModelCatalog: () => [],
}));

vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));

vi.mock("./workspace.js", () => ({
  ensureAgentWorkspace: vi.fn(async () => undefined),
}));

vi.mock("./auth-profiles/store.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-profiles/store.js")>(
    "./auth-profiles/store.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: () => ({ profiles: {} }),
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async () => ({ profiles: {} })),
  };
});

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => null,
  }),
}));

vi.mock("../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => ({ enabled: false, reason: "test" }),
}));

vi.mock("../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: () => ({
    shouldRefresh: true,
    snapshot: {
      prompt: "",
      skills: [],
      resolvedSkills: [],
      version: 0,
    },
  }),
}));

vi.mock("./exec-defaults.js", () => ({
  canExecRequestNode: () => false,
}));

vi.mock("./model-fallback.js", () => ({
  runWithModelFallback: async (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await params.run(params.provider, params.model),
    provider: params.provider,
    model: params.model,
    attempts: [],
  }),
}));

vi.mock("./command/attempt-execution.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./command/attempt-execution.runtime.js")>(
    "./command/attempt-execution.runtime.js",
  );
  return {
    ...actual,
    runAgentAttempt: (...args: unknown[]) => state.runAgentAttemptMock(...args),
  };
});

vi.mock("./command/cli-compaction.js", () => ({
  runCliTurnCompactionLifecycle: async (params: { sessionEntry?: SessionEntry }) =>
    params.sessionEntry,
}));

vi.mock("./command/delivery.runtime.js", () => ({
  deliverAgentCommandResult: async (params: {
    resolveFreshSessionEntryForDelivery?: () => Promise<SessionEntry | undefined>;
  }) => {
    state.deliveryFreshEntries.push(await params.resolveFreshSessionEntryForDelivery?.());
    return { deliverySucceeded: true };
  },
}));

let agentCommand: typeof import("./agent-command.js").agentCommand;

beforeAll(async () => {
  agentCommand = (await import("./agent-command.js")).agentCommand;
});

beforeEach(() => {
  vi.clearAllMocks();
  state.deliveryFreshEntries = [];
  state.sessionRows = new Map();
  state.workspaceDir = "/tmp/openclaw-rotation-workspace";
  state.agentDir = "/tmp/openclaw-rotation-agent";
  state.cfg = {
    agents: {
      defaults: {
        models: {
          "openai/gpt-5.5": {},
        },
      },
    },
  } as OpenClawConfig;
});

afterEach(() => {
  state.cfg = undefined;
  state.workspaceDir = undefined;
  state.agentDir = undefined;
  state.sessionRows = new Map();
});

function makeResult(params: { sessionId: string; text: string; compactionCount?: number }) {
  return {
    payloads: [{ text: params.text }],
    meta: {
      durationMs: 1,
      stopReason: "end_turn",
      executionTrace: {
        runner: "embedded",
        fallbackUsed: false,
        winnerProvider: "openai",
        winnerModel: "gpt-5.5",
      },
      finalAssistantVisibleText: params.text,
      agentMeta: {
        sessionId: params.sessionId,
        provider: "openai",
        model: "gpt-5.5",
        ...(params.compactionCount ? { compactionCount: params.compactionCount } : {}),
      },
    },
  };
}

describe("agentCommand compaction transcript rotation", () => {
  it("persists the rotated successor under the original session key", async () => {
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId: "rotated-session",
        text: "first answer after rotation",
        compactionCount: 1,
      }),
    );

    await agentCommand({
      message: "first prompt",
      sessionId: "old-session",
      cwd: state.workspaceDir,
    });

    const entries = Array.from(state.sessionRows.entries());
    expect(entries).toHaveLength(1);
    const [sessionKey, rotatedEntry] = entries[0] ?? [];
    expect(sessionKey).toBe("agent:main:explicit:old-session");
    expect(rotatedEntry).toMatchObject({
      sessionId: "rotated-session",
      usageFamilyKey: "agent:main:explicit:old-session",
      usageFamilySessionIds: ["old-session", "rotated-session"],
      compactionCount: 1,
    });
  });

  it("resumes the next turn from the rotated successor", async () => {
    const sessionKey = "agent:main:explicit:old-session";
    state.sessionRows.set(sessionKey, {
      sessionId: "rotated-session",
      updatedAt: Date.now(),
      usageFamilyKey: sessionKey,
      usageFamilySessionIds: ["old-session", "rotated-session"],
      compactionCount: 1,
    });
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId: "rotated-session",
        text: "second answer",
      }),
    );

    await agentCommand({
      message: "second prompt",
      sessionId: "rotated-session",
      cwd: state.workspaceDir,
    });

    const secondAttempt = state.runAgentAttemptMock.mock.calls[0]?.[0] as
      | { sessionId?: string; sessionKey?: string }
      | undefined;
    expect(secondAttempt).toMatchObject({
      sessionId: "rotated-session",
      sessionKey,
    });
    expect(state.deliveryFreshEntries.at(-1)).toMatchObject({
      sessionId: "rotated-session",
    });
    expect(state.sessionRows.get(sessionKey)).toMatchObject({
      sessionId: "rotated-session",
    });
  });
});
