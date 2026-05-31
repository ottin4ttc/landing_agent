import { expect, test, vi } from "vitest";
import { getSessionEntry } from "../config/sessions.js";
import {
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
} from "../config/sessions/transcript-store.sqlite.js";
import {
  agentDiscoveryMock,
  rpcReq,
  testState,
  seedGatewaySessionEntries,
} from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
  sessionHookMocks,
  sessionLifecycleHookMocks,
} from "./test/server-sessions.test-helpers.js";

const { createSessionFixtureDir, openClient } = setupGatewaySessionsTestHarness();

function requireNonEmptyString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

test("sessions.create stores dashboard session model and parent linkage, and creates a transcript", async () => {
  await createSessionFixtureDir();
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-parent"),
    },
  });
  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      label?: string;
      providerOverride?: string;
      modelOverride?: string;
      parentSessionKey?: string;
    };
  }>("sessions.create", {
    agentId: "ops",
    label: "Dashboard Chat",
    model: "openai/gpt-test-a",
    parentSessionKey: "main",
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
  expect(created.payload?.entry?.label).toBe("Dashboard Chat");
  expect(created.payload?.entry?.providerOverride).toBe("openai");
  expect(created.payload?.entry?.modelOverride).toBe("gpt-test-a");
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

  const key = requireNonEmptyString(created.payload?.key, "created session key");
  const sessionId = requireNonEmptyString(created.payload?.sessionId, "created session id");
  const stored = getSessionEntry({ agentId: "ops", sessionKey: key });
  expect(stored?.sessionId).toBe(sessionId);
  expect(stored?.label).toBe("Dashboard Chat");
  expect(stored?.providerOverride).toBe("openai");
  expect(stored?.modelOverride).toBe("gpt-test-a");
  expect(stored?.parentSessionKey).toBe("agent:main:main");

  const [header] = loadSqliteSessionTranscriptEvents({ agentId: "ops", sessionId });
  expect(header?.event).toMatchObject({ type: "session", id: sessionId });
});

test("sessions.create inherits parent runtime model selection when model is omitted", async () => {
  await createSessionFixtureDir();
  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-parent", {
        providerOverride: "codex",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "user",
        agentRuntimeOverride: "codex",
        modelProvider: "codex",
        model: "gpt-5.5",
        contextTokens: 272000,
        thinkingLevel: "off",
        traceLevel: "debug",
        authProfileOverride: "codex-oauth",
        authProfileOverrideSource: "user",
      }),
    },
  });

  const created = await directSessionReq<{
    key?: string;
    entry?: {
      providerOverride?: string;
      modelOverride?: string;
      modelOverrideSource?: string;
      agentRuntimeOverride?: string;
      modelProvider?: string;
      model?: string;
      contextTokens?: number;
      thinkingLevel?: string;
      traceLevel?: string;
      authProfileOverride?: string;
      authProfileOverrideSource?: string;
      parentSessionKey?: string;
    };
  }>("sessions.create", {
    agentId: "main",
    label: "Fresh Chat",
    parentSessionKey: "main",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.entry?.providerOverride).toBe("codex");
  expect(created.payload?.entry?.modelOverride).toBe("gpt-5.5");
  expect(created.payload?.entry?.modelOverrideSource).toBe("user");
  expect(created.payload?.entry?.agentRuntimeOverride).toBe("codex");
  expect(created.payload?.entry?.modelProvider).toBe("codex");
  expect(created.payload?.entry?.model).toBe("gpt-5.5");
  expect(created.payload?.entry?.contextTokens).toBe(272000);
  expect(created.payload?.entry?.thinkingLevel).toBe("off");
  expect(created.payload?.entry?.traceLevel).toBe("debug");
  expect(created.payload?.entry?.authProfileOverride).toBe("codex-oauth");
  expect(created.payload?.entry?.authProfileOverrideSource).toBe("user");

  const key = created.payload?.key as string;
  const stored = getSessionEntry({ agentId: "main", sessionKey: key });
  expect(stored?.providerOverride).toBe("codex");
  expect(stored?.modelOverride).toBe("gpt-5.5");
  expect(stored?.parentSessionKey).toBe("agent:main:main");
});

test("sessions.create accepts an explicit key for persistent dashboard sessions", async () => {
  await createSessionFixtureDir();

  const key = "agent:ops-agent:dashboard:direct:subagent-orchestrator";
  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      label?: string;
    };
  }>("sessions.create", {
    key,
    label: "Dashboard Orchestrator",
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.key).toBe(key);
  expect(created.payload?.entry?.label).toBe("Dashboard Orchestrator");
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("sessions.create scopes the main alias to the requested agent", async () => {
  await createSessionFixtureDir();

  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: Record<string, unknown>;
  }>("sessions.create", {
    key: "main",
    agentId: "longmemeval",
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.key).toBe("agent:longmemeval:main");

  expect(
    getSessionEntry({ agentId: "longmemeval", sessionKey: "agent:longmemeval:main" })?.sessionId,
  ).toBe(created.payload?.sessionId);
  expect(getSessionEntry({ agentId: "main", sessionKey: "agent:main:main" })?.sessionId).not.toBe(
    created.payload?.sessionId,
  );
});

test("sessions.create replaces a dead main entry with a fresh session id", async () => {
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  try {
    await seedGatewaySessionEntries({
      agentId: "ops",
      entries: {
        main: {
          updatedAt: 1,
          label: "Ops Main",
        },
      },
    });

    const created = await directSessionReq<{
      key?: string;
      sessionId?: string;
      entry?: {
        label?: string;
      };
    }>("sessions.create", {
      key: "main",
      agentId: "ops",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toBe("agent:ops:main");
    expect(created.payload?.sessionId).toBe("agent:ops:main");
    expect(created.payload?.entry?.label).toBe("Ops Main");

    const stored = getSessionEntry({ agentId: "ops", sessionKey: "agent:ops:main" });
    expect(stored?.sessionId).toBe(created.payload?.sessionId);
  } finally {
    testState.agentsConfig = undefined;
  }
});

test("sessions.create preserves global and unknown sentinel keys", async () => {
  await createSessionFixtureDir();

  const globalCreated = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: Record<string, unknown>;
  }>("sessions.create", {
    key: "global",
    agentId: "longmemeval",
  });

  expect(globalCreated.ok).toBe(true);
  expect(globalCreated.payload?.key).toBe("global");

  const unknownCreated = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: Record<string, unknown>;
  }>("sessions.create", {
    key: "unknown",
    agentId: "longmemeval",
  });

  expect(unknownCreated.ok).toBe(true);
  expect(unknownCreated.payload?.key).toBe("unknown");

  expect(getSessionEntry({ agentId: "main", sessionKey: "global" })?.sessionId).toBe(
    globalCreated.payload?.sessionId,
  );
  expect(getSessionEntry({ agentId: "main", sessionKey: "unknown" })?.sessionId).toBe(
    unknownCreated.payload?.sessionId,
  );
  expect(
    getSessionEntry({ agentId: "longmemeval", sessionKey: "agent:longmemeval:global" }),
  ).toBeUndefined();
  expect(
    getSessionEntry({ agentId: "longmemeval", sessionKey: "agent:longmemeval:unknown" }),
  ).toBeUndefined();
});

test("sessions.create stores selected global sessions in the requested agent store", async () => {
  await createSessionFixtureDir();
  testState.sessionConfig = { scope: "global" };
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
  // SQLite stores persist across cases; clear both agents' rows so the default
  // agent's global store is provably empty after the work-scoped create.
  await seedGatewaySessionEntries({ agentId: "main", entries: {} });
  await seedGatewaySessionEntries({ agentId: "work", entries: {} });
  const broadcastToConnIds = vi.fn();

  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: { sessionId?: string };
  }>(
    "sessions.create",
    {
      key: "global",
      agentId: "work",
    },
    {
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      },
    },
  );

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toBe("global");
  requireNonEmptyString(created.payload?.entry?.sessionId, "work global session id");
  // Selected global scope keeps a per-agent global row; the requested agent's
  // SQLite store gets the session and the default agent's store stays empty.
  expect(getSessionEntry({ agentId: "main", sessionKey: "global" })).toBeUndefined();
  expect(getSessionEntry({ agentId: "work", sessionKey: "global" })?.sessionId).toBe(
    created.payload?.sessionId,
  );
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({ sessionKey: "global", agentId: "work", reason: "create" }),
    new Set(["conn-1"]),
    { dropIfSlow: true },
  );
  testState.sessionConfig = undefined;
  testState.agentsConfig = undefined;
});

test("sessions.create loads selected global parent from the requested agent store", async () => {
  await createSessionFixtureDir();
  testState.sessionConfig = { scope: "global" };
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
  try {
    // Global scope keeps a per-agent "global" row; seed each agent's SQLite
    // store so the requested agent's parent (work) is loaded, not the default.
    await seedGatewaySessionEntries({
      agentId: "main",
      entries: {
        global: sessionStoreEntry("sess-main-parent", {
          providerOverride: "codex",
          modelOverride: "main-model",
        }),
      },
    });
    await seedGatewaySessionEntries({
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-parent", {
          providerOverride: "openai",
          modelOverride: "work-model",
          thinkingLevel: "high",
        }),
      },
    });

    const created = await directSessionReq<{
      key?: string;
      entry?: {
        parentSessionKey?: string;
        providerOverride?: string;
        modelOverride?: string;
        thinkingLevel?: string;
      };
    }>("sessions.create", {
      agentId: "work",
      parentSessionKey: "global",
      emitCommandHooks: true,
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:work:dashboard:/);
    expect(created.payload?.entry?.parentSessionKey).toBe("global");
    expect(created.payload?.entry?.providerOverride).toBe("openai");
    expect(created.payload?.entry?.modelOverride).toBe("work-model");
    expect(created.payload?.entry?.thinkingLevel).toBe("high");

    const commandNewEvent = (
      sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
    )
      .map((call) => call[0])
      .find(
        (
          event,
        ): event is {
          context?: { sessionEntry?: { sessionId?: string } };
        } =>
          Boolean(event) &&
          typeof event === "object" &&
          (event as { type?: unknown }).type === "command" &&
          (event as { action?: unknown }).action === "new",
      );
    expect(commandNewEvent?.context?.sessionEntry?.sessionId).toBe("sess-work-parent");
    const [endEvent] = sessionLifecycleHookMocks.runSessionEnd.mock.calls[0] as unknown as [
      { sessionId?: string; sessionKey?: string },
      unknown,
    ];
    expect(endEvent.sessionId).toBe("sess-work-parent");
    expect(endEvent.sessionKey).toBe("global");
  } finally {
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.get reads selected global messages from the requested agent store", async () => {
  await createSessionFixtureDir();
  // Transcripts are SQLite-backed and keyed by { agentId, sessionId }; seed each
  // agent's global transcript directly so sessions.get reads the requested agent's.
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "sess-main-global",
    events: [{ type: "message", id: "main-msg", message: { role: "user", content: "main global" } }],
  });
  replaceSqliteSessionTranscriptEvents({
    agentId: "work",
    sessionId: "sess-work-global",
    events: [{ type: "message", id: "work-msg", message: { role: "user", content: "work global" } }],
  });
  testState.sessionConfig = { scope: "global" };
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
  try {
    // Seed each agent's per-agent "global" session row in SQLite so sessions.get
    // resolves the requested agent's (work) global transcript.
    await seedGatewaySessionEntries({
      agentId: "main",
      entries: {
        global: sessionStoreEntry("sess-main-global"),
      },
    });
    await seedGatewaySessionEntries({
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-global"),
      },
    });

    const result = await directSessionReq<{ messages?: unknown[] }>("sessions.get", {
      key: "global",
      agentId: "work",
    });

    expect(result.ok).toBe(true);
    const renderedMessages = JSON.stringify(result.payload?.messages ?? []);
    expect(renderedMessages).toContain("work global");
    expect(renderedMessages).not.toContain("main global");
  } finally {
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.create sends selected global initial tasks to the requested agent", async () => {
  await createSessionFixtureDir();
  testState.sessionConfig = { scope: "global" };
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
  // SQLite stores persist across cases; clear both agents' rows so the default
  // agent's global store is provably empty after the work-scoped task create.
  await seedGatewaySessionEntries({ agentId: "main", entries: {} });
  await seedGatewaySessionEntries({ agentId: "work", entries: {} });
  const { ws } = await openClient();

  const created = await rpcReq<{
    key?: string;
    runStarted?: boolean;
    runId?: string;
  }>(ws, "sessions.create", {
    key: "global",
    agentId: "work",
    task: "hello selected global",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toBe("global");
  expect(created.payload?.runStarted).toBe(true);
  const runId = requireNonEmptyString(created.payload?.runId, "selected global run id");
  const wait = await rpcReq(ws, "agent.wait", { runId, timeoutMs: 1_000 });
  expect(wait.ok).toBe(true);
  // Global scope writes the session to the requested agent's (work) SQLite store;
  // the default agent's store stays empty.
  const workSessionId = requireNonEmptyString(
    getSessionEntry({ agentId: "work", sessionKey: "global" })?.sessionId,
    "selected global session id",
  );
  // Transcript is SQLite-backed; read the work agent's transcript by session id.
  const workEvents = loadSqliteSessionTranscriptEvents({ agentId: "work", sessionId: workSessionId });
  expect(JSON.stringify(workEvents)).toContain("hello selected global");
  expect(getSessionEntry({ agentId: "main", sessionKey: "global" })).toBeUndefined();
  testState.sessionConfig = undefined;
  testState.agentsConfig = undefined;
  ws.close();
});

test("sessions.create rejects unknown parentSessionKey", async () => {
  await createSessionFixtureDir();

  const created = await directSessionReq("sessions.create", {
    agentId: "ops",
    parentSessionKey: "agent:main:missing",
  });

  expect(created.ok).toBe(false);
  expect((created.error as { message?: string } | undefined)?.message ?? "").toContain(
    "unknown parent session",
  );
});

test("sessions.create can start the first agent turn from an initial task", async () => {
  await createSessionFixtureDir();
  // Register "ops" so the deleted-agent guard added in #65986 does not
  // reject the auto-started chat.send triggered by `task:`.
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  const { ws } = await openClient();

  const created = await rpcReq<{
    key?: string;
    sessionId?: string;
    runStarted?: boolean;
    runId?: string;
    messageSeq?: number;
  }>(ws, "sessions.create", {
    agentId: "ops",
    label: "Dashboard Task Chat",
    task: "hello from create",
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(created.payload?.runStarted).toBe(true);
  const runId = requireNonEmptyString(created.payload?.runId, "started run id");
  expect(created.payload?.messageSeq).toBe(1);

  const wait = await rpcReq(ws, "agent.wait", { runId, timeoutMs: 1_000 });
  expect(wait.ok).toBe(true);
  expect(wait.payload?.status).toBe("ok");

  ws.close();
});
