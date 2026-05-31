import "./test-helpers/fast-coding-tools.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appendSessionTranscriptMessage } from "../config/sessions/transcript-append.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  buildEmbeddedRunnerAssistant,
  cleanupEmbeddedAgentRunnerTestWorkspace,
  createMockUsage,
  createEmbeddedAgentRunnerOpenAiConfig,
  createResolvedEmbeddedRunnerModel,
  createEmbeddedAgentRunnerTestWorkspace,
  type EmbeddedAgentRunnerTestWorkspace,
  immediateEnqueue,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";
import { readTranscriptStateForSession } from "./transcript/transcript-persistence.js";

type EmbeddedRunnerModelResolution =
  | ReturnType<typeof createResolvedEmbeddedRunnerModel>
  | {
      model?: undefined;
      error: string;
      authStorage: { setRuntimeApiKey: () => undefined };
      modelRegistry: Record<string, never>;
    };

const runEmbeddedAttemptMock = vi.fn();
const disposeSessionMcpRuntimeMock = vi.fn<(sessionId: string) => Promise<void>>(async () => {
  return undefined;
});
const resolveSessionKeyForRequestMock = vi.fn();
const resolveStoredSessionKeyForSessionIdMock = vi.fn();
const resolveModelAsyncMock = vi.fn(
  async (provider: string, modelId: string): Promise<EmbeddedRunnerModelResolution> =>
    createResolvedEmbeddedRunnerModel(provider, modelId),
);
const ensureOpenClawModelCatalogMock = vi.fn(async () => ({ wrote: false }));
const loggerWarnMock = vi.fn();
let refreshRuntimeAuthOnFirstPromptError = false;

vi.mock("./pi-ai-contract.js", async () => {
  const actual = await vi.importActual<typeof import("./pi-ai-contract.js")>("./pi-ai-contract.js");

  const buildAssistantMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "ok" }],
    stopReason: "stop" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(1, 1),
    timestamp: Date.now(),
  });

  const buildAssistantErrorMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [],
    stopReason: "error" as const,
    errorMessage: "boom",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(0, 0),
    timestamp: Date.now(),
  });

  return {
    ...actual,
    complete: async (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") {
        return buildAssistantErrorMessage(model);
      }
      return buildAssistantMessage(model);
    },
    completeSimple: async (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") {
        return buildAssistantErrorMessage(model);
      }
      return buildAssistantMessage(model);
    },
    streamSimple: (model: { api: string; provider: string; id: string }) => {
      const stream = actual.createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message:
            model.id === "mock-error"
              ? buildAssistantErrorMessage(model)
              : buildAssistantMessage(model),
        });
        stream.end();
      });
      return stream;
    },
  };
});

const installRunEmbeddedMocks = () => {
  installEmbeddedRunnerBaseE2eMocks({ hookRunner: "full" });
  installEmbeddedRunnerFastRunE2eMocks({
    runEmbeddedAttempt: (params) => runEmbeddedAttemptMock(params),
  });
  vi.doMock("./command/session.js", async () => {
    const actual =
      await vi.importActual<typeof import("./command/session.js")>("./command/session.js");
    return {
      ...actual,
      resolveSessionKeyForRequest: (opts: unknown) => resolveSessionKeyForRequestMock(opts),
      resolveStoredSessionKeyForSessionId: (opts: unknown) =>
        resolveStoredSessionKeyForSessionIdMock(opts),
    };
  });
  vi.doMock("./embedded-agent-runner/logger.js", async () => {
    const actual = await vi.importActual<typeof import("./embedded-agent-runner/logger.js")>(
      "./embedded-agent-runner/logger.js",
    );
    return {
      ...actual,
      log: {
        ...actual.log,
        warn: (...args: unknown[]) => loggerWarnMock(...args),
      },
    };
  });
  vi.doMock("./agent-bundle-mcp-tools.js", () => ({
    disposeSessionMcpRuntime: (sessionId: string) => disposeSessionMcpRuntimeMock(sessionId),
    retireSessionMcpRuntimeForSessionKey: () => Promise.resolve(false),
    retireSessionMcpRuntime: ({ sessionId }: { sessionId?: string | null }) =>
      sessionId ? disposeSessionMcpRuntimeMock(sessionId) : Promise.resolve(false),
  }));
  vi.doMock("./embedded-agent-runner/model.js", async () => {
    const actual = await vi.importActual<typeof import("./embedded-agent-runner/model.js")>(
      "./embedded-agent-runner/model.js",
    );
    return {
      ...actual,
      resolveModelAsync: (...args: Parameters<typeof resolveModelAsyncMock>) =>
        resolveModelAsyncMock(...args),
    };
  });
  vi.doMock("./embedded-agent-runner/run/auth-controller.js", () => ({
    createEmbeddedRunAuthController: () => ({
      advanceAuthProfile: vi.fn(async () => false),
      initializeAuthProfile: vi.fn(async () => undefined),
      maybeRefreshRuntimeAuthForAuthError: vi.fn(async (_errorText: string, runtimeAuthRetry) => {
        return refreshRuntimeAuthOnFirstPromptError && runtimeAuthRetry !== true;
      }),
      stopRuntimeAuthRefreshTimer: vi.fn(),
    }),
  }));
  vi.doMock("./models-config.js", async () => {
    const mod = await vi.importActual<typeof import("./models-config.js")>("./models-config.js");
    return {
      ...mod,
      ensureOpenClawModelCatalog: (...args: Parameters<typeof ensureOpenClawModelCatalogMock>) =>
        ensureOpenClawModelCatalogMock(...args),
    };
  });
};

let runEmbeddedAgent: typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
let e2eWorkspace: EmbeddedAgentRunnerTestWorkspace | undefined;
let agentDir: string;
let workspaceDir: string;
let sessionCounter = 0;
let runCounter = 0;
let previousStateDir: string | undefined;

beforeAll(async () => {
  vi.useRealTimers();
  vi.resetModules();
  installRunEmbeddedMocks();
  e2eWorkspace = await createEmbeddedAgentRunnerTestWorkspace("openclaw-embedded-agent-");
  ({ agentDir, workspaceDir } = e2eWorkspace);
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = e2eWorkspace.stateDir;
  ({ runEmbeddedAgent } = await import("./embedded-agent-runner/run.js"));
}, 180_000);

afterAll(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  await cleanupEmbeddedAgentRunnerTestWorkspace(e2eWorkspace);
  e2eWorkspace = undefined;
});

beforeEach(() => {
  vi.useRealTimers();
  runEmbeddedAttemptMock.mockReset();
  disposeSessionMcpRuntimeMock.mockReset();
  resolveSessionKeyForRequestMock.mockReset();
  resolveStoredSessionKeyForSessionIdMock.mockReset();
  resolveModelAsyncMock.mockReset();
  resolveModelAsyncMock.mockImplementation(async (provider: string, modelId: string) =>
    createResolvedEmbeddedRunnerModel(provider, modelId),
  );
  ensureOpenClawModelCatalogMock.mockReset();
  ensureOpenClawModelCatalogMock.mockResolvedValue({ wrote: false });
  loggerWarnMock.mockReset();
  refreshRuntimeAuthOnFirstPromptError = false;
  runEmbeddedAttemptMock.mockImplementation(async () => {
    throw new Error("unexpected extra runEmbeddedAttempt call");
  });
});

const nextSessionId = () => {
  sessionCounter += 1;
  return `session-${sessionCounter}`;
};
const appendTestSessionMessage = async (sessionId: string, message: unknown) =>
  await appendSessionTranscriptMessage({
    agentId: "test",
    sessionId,
    cwd: workspaceDir,
    message,
  });
const nextRunId = (prefix = "run-embedded-test") => `${prefix}-${++runCounter}`;
const nextSessionKey = () => `agent:test:embedded:${nextRunId("session-key")}`;

const runWithOrphanedSingleUserMessage = async (text: string, sessionKey: string) => {
  const sessionId = nextSessionId();
  await appendTestSessionMessage(sessionId, {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });

  runEmbeddedAttemptMock.mockResolvedValueOnce(
    makeEmbeddedRunnerAttempt({
      assistantTexts: ["ok"],
      lastAssistant: buildEmbeddedRunnerAssistant({
        content: [{ type: "text", text: "ok" }],
      }),
    }),
  );

  const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
  return await runEmbeddedAgent({
    sessionId: sessionId,
    sessionKey,
    workspaceDir,
    config: cfg,
    prompt: "hello",
    provider: "openai",
    model: "mock-1",
    timeoutMs: 5_000,
    agentDir,
    runId: nextRunId("orphaned-user"),
    enqueue: immediateEnqueue,
  });
};

const textFromContent = (content: unknown) => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content[0]?.type === "text") {
    return (content[0] as { text?: string }).text;
  }
  return undefined;
};

const readSessionEntries = async (
  sessionId: string,
): Promise<
  Array<{
    type?: string;
    customType?: string;
    data?: unknown;
  }>
> => {
  try {
    return (
      await readTranscriptStateForSession({ agentId: "test", sessionId })
    ).getEntries() as Array<{
      type?: string;
      customType?: string;
      data?: unknown;
    }>;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("Transcript is not in SQLite:") ||
        error.message.startsWith("Transcript is not in the SQLite state database"))
    ) {
      return [];
    }
    throw error;
  }
};

const readSessionMessages = async (sessionId: string) => {
  const entries = await readSessionEntries(sessionId);
  return entries
    .filter((entry) => entry.type === "message")
    .map(
      (entry) => (entry as { message?: { role?: string; content?: unknown } }).message,
    ) as Array<{ role?: string; content?: unknown }>;
};

const runDefaultEmbeddedTurn = async (sessionId: string, prompt: string, sessionKey: string) => {
  const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-error"]);
  runEmbeddedAttemptMock.mockResolvedValueOnce(
    makeEmbeddedRunnerAttempt({
      assistantTexts: ["ok"],
      lastAssistant: buildEmbeddedRunnerAssistant({
        content: [{ type: "text", text: "ok" }],
      }),
    }),
  );
  await runEmbeddedAgent({
    sessionId,
    sessionKey,
    workspaceDir,
    config: cfg,
    prompt,
    provider: "openai",
    model: "mock-error",
    timeoutMs: 5_000,
    agentDir,
    runId: nextRunId("default-turn"),
    enqueue: immediateEnqueue,
  });
};

function firstMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call;
}

function firstRunEmbeddedAttemptParams(): { sessionKey?: string } {
  return firstMockCall(runEmbeddedAttemptMock, "embedded attempt")[0] as { sessionKey?: string };
}

describe("runEmbeddedAgent", () => {
  it("skips model catalog generation when dynamic model resolution succeeds", async () => {
    const sessionId = nextSessionId();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig([]);
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openrouter",
      model: "openrouter/auto",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("dynamic-model"),
      enqueue: immediateEnqueue,
    });

    const resolveModelCall = firstMockCall(resolveModelAsyncMock, "model resolution");
    expect(resolveModelCall?.[0]).toBe("openrouter");
    expect(resolveModelCall?.[1]).toBe("openrouter/auto");
    expect(resolveModelCall?.[2]).toBe(agentDir);
    expect(resolveModelCall?.[3]).toBe(cfg);
    expect(
      (resolveModelCall?.[4] as { skipAgentDiscovery?: boolean } | undefined)?.skipAgentDiscovery,
    ).toBe(true);
    expect(ensureOpenClawModelCatalogMock).not.toHaveBeenCalled();
  });

  it("resolves explicit OpenAI PI runs through Codex when auth order starts with Codex OAuth", async () => {
    const baseConfig = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    const openAIProvider = baseConfig.models?.providers?.openai;
    if (!openAIProvider) {
      throw new Error("expected OpenAI provider test config");
    }
    const cfg = {
      ...baseConfig,
      models: {
        providers: {
          openai: {
            ...openAIProvider,
            baseUrl: "https://api.openai.com/v1",
          },
        },
      },
      agents: {
        defaults: {
          models: {
            "openai/mock-1": {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      },
      auth: {
        order: {
          openai: ["openai:work", "openai:backup"],
        },
      },
    };
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId: "codex-first-pi",
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("codex-first-openclaw"),
      enqueue: immediateEnqueue,
    });

    expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
      1,
      "openai",
      "mock-1",
      agentDir,
      cfg,
      expect.objectContaining({ skipAgentDiscovery: true }),
    );
    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(1);
    expect(
      (firstRunEmbeddedAttemptParams() as { model?: { provider?: string } }).model?.provider,
    ).toBe("openai");
  });

  it("resolves transport-owned OpenAI Codex runs against the runtime provider first", async () => {
    const sessionId = nextSessionId();
    const baseConfig = createEmbeddedAgentRunnerOpenAiConfig([]);
    const openAIProvider = baseConfig.models?.providers?.openai;
    if (!openAIProvider) {
      throw new Error("expected OpenAI provider test config");
    }
    const cfg = {
      ...baseConfig,
      models: {
        providers: {
          openai: {
            ...openAIProvider,
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    };
    resolveModelAsyncMock.mockImplementation(async (provider: string, modelId: string) => {
      if (provider === "openai" && modelId === "gpt-5.5") {
        return createResolvedEmbeddedRunnerModel(provider, modelId);
      }
      return {
        error: `Unknown model: ${provider}/${modelId}`,
        authStorage: {
          setRuntimeApiKey: () => undefined,
        },
        modelRegistry: {},
      };
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "gpt-5.5",
      timeoutMs: 5_000,
      agentDir,
      agentHarnessId: "codex",
      runId: nextRunId("codex-runtime-model"),
      enqueue: immediateEnqueue,
    });

    expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
      1,
      "openai",
      "gpt-5.5",
      agentDir,
      cfg,
      expect.objectContaining({ skipAgentDiscovery: true }),
    );
    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(1);
    expect(ensureOpenClawModelCatalogMock).not.toHaveBeenCalled();
    expect(
      (firstRunEmbeddedAttemptParams() as { model?: { provider?: string } }).model?.provider,
    ).toBe("openai");
  });

  it("backfills a trimmed session key from sessionId when the embedded run omits it", async () => {
    const sessionId = nextSessionId();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    resolveSessionKeyForRequestMock.mockReturnValue({
      sessionKey: "agent:test:resolved",
      sessionStore: {},
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId,
      sessionKey: "   ",
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("backfill"),
      enqueue: immediateEnqueue,
    });

    expect(resolveSessionKeyForRequestMock).toHaveBeenCalledWith({
      cfg,
      sessionId,
      agentId: undefined,
      clone: false,
    });
    expect(firstRunEmbeddedAttemptParams().sessionKey).toBe("agent:test:resolved");
  });

  it("drops whitespace-only session keys when backfill cannot resolve a session key", async () => {
    const sessionId = nextSessionId();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    resolveSessionKeyForRequestMock.mockReturnValue({
      sessionKey: undefined,
      sessionStore: {},
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId,
      sessionKey: "   ",
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("backfill-empty"),
      enqueue: immediateEnqueue,
    });

    expect(resolveSessionKeyForRequestMock).toHaveBeenCalledWith({
      cfg,
      sessionId,
      agentId: undefined,
      clone: false,
    });
    expect(firstRunEmbeddedAttemptParams().sessionKey).toBeUndefined();
  });

  it("logs when embedded session-key backfill resolution fails", async () => {
    const sessionId = nextSessionId();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    resolveSessionKeyForRequestMock.mockImplementation(() => {
      throw new Error("resolver exploded");
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("backfill-warn"),
      enqueue: immediateEnqueue,
    });

    expect(
      loggerWarnMock.mock.calls.some(([message]) =>
        String(message ?? "").includes("[backfillSessionKey] Failed to resolve sessionKey"),
      ),
    ).toBe(true);
  });

  it("passes the current agentId when backfilling a session key", async () => {
    const sessionId = nextSessionId();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    resolveStoredSessionKeyForSessionIdMock.mockReturnValue({
      sessionKey: "agent:test:resolved",
      sessionStore: {},
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId,
      sessionKey: undefined,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      agentId: "embedded-agent",
      runId: nextRunId("backfill-agent-scope"),
      enqueue: immediateEnqueue,
    });

    expect(resolveStoredSessionKeyForSessionIdMock).toHaveBeenCalledWith({
      cfg,
      sessionId,
      agentId: "embedded-agent",
    });
    expect(resolveSessionKeyForRequestMock).not.toHaveBeenCalled();
  });

  it("disposes bundle MCP once when a one-shot local run completes", async () => {
    const sessionId = nextSessionId();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    const sessionKey = nextSessionKey();
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );

    await runEmbeddedAgent({
      sessionId,
      sessionKey,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("bundle-mcp-run-cleanup"),
      enqueue: immediateEnqueue,
      cleanupBundleMcpOnRunEnd: true,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledTimes(1);
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledWith(sessionId);
  });

  it("preserves bundle MCP state across retries within one local run", async () => {
    refreshRuntimeAuthOnFirstPromptError = true;
    const sessionId = nextSessionId();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    const sessionKey = nextSessionKey();
    runEmbeddedAttemptMock
      .mockImplementationOnce(async () => {
        expect(disposeSessionMcpRuntimeMock).not.toHaveBeenCalled();
        return makeEmbeddedRunnerAttempt({
          promptError: new Error("401 unauthorized"),
        });
      })
      .mockImplementationOnce(async () => {
        expect(disposeSessionMcpRuntimeMock).not.toHaveBeenCalled();
        return makeEmbeddedRunnerAttempt({
          assistantTexts: ["ok"],
          lastAssistant: buildEmbeddedRunnerAssistant({
            content: [{ type: "text", text: "ok" }],
          }),
        });
      });

    const result = await runEmbeddedAgent({
      sessionId,
      sessionKey,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("bundle-mcp-retry"),
      enqueue: immediateEnqueue,
      cleanupBundleMcpOnRunEnd: true,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.text).toBe("ok");
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledTimes(1);
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledWith(sessionId);
  });

  it("retries a planning-only GPT turn once with an act-now steer", async () => {
    const sessionId = nextSessionId();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["gpt-5.4"]);
    const sessionKey = nextSessionKey();

    runEmbeddedAttemptMock
      .mockImplementationOnce(async (params: unknown) => {
        expect((params as { prompt?: string }).prompt).toMatch(/^ship it(?:\n\n|$)/);
        return makeEmbeddedRunnerAttempt({
          assistantTexts: ["I'll inspect the files, make the change, and run the checks."],
          lastAssistant: buildEmbeddedRunnerAssistant({
            model: "gpt-5.4",
            content: [
              {
                type: "text",
                text: "I'll inspect the files, make the change, and run the checks.",
              },
            ],
          }),
        });
      })
      .mockImplementationOnce(async (params: unknown) => {
        expect((params as { prompt?: string }).prompt).toContain(
          "Do not restate the plan. Act now",
        );
        return makeEmbeddedRunnerAttempt({
          assistantTexts: ["done"],
          lastAssistant: buildEmbeddedRunnerAssistant({
            model: "gpt-5.4",
            content: [{ type: "text", text: "done" }],
          }),
        });
      });

    const result = await runEmbeddedAgent({
      sessionId: sessionId,
      sessionKey,
      workspaceDir,
      config: cfg,
      prompt: "ship it",
      provider: "openai",
      model: "gpt-5.4",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("planning-only-retry"),
      enqueue: immediateEnqueue,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.text).toBe("done");
  });

  it("handles prompt error paths without dropping user state", async () => {
    const sessionId = nextSessionId();
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-error"]);
    const sessionKey = nextSessionKey();
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        promptError: new Error("boom"),
      }),
    );
    await expect(
      runEmbeddedAgent({
        sessionId: sessionId,
        sessionKey,
        workspaceDir,
        config: cfg,
        prompt: "boom",
        provider: "openai",
        model: "mock-error",
        timeoutMs: 5_000,
        agentDir,
        runId: nextRunId("prompt-error"),
        enqueue: immediateEnqueue,
      }),
    ).rejects.toThrow("boom");

    const messages = await readSessionMessages(sessionId);
    if (messages.length > 0) {
      const userIndex = messages.findIndex(
        (message) => message?.role === "user" && textFromContent(message.content) === "boom",
      );
      expect(userIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it(
    "preserves existing transcript entries across an additional turn",
    { timeout: 7_000 },
    async () => {
      const sessionId = nextSessionId();
      const sessionKey = nextSessionKey();

      await appendTestSessionMessage(sessionId, {
        role: "user",
        content: [{ type: "text", text: "seed user" }],
        timestamp: Date.now(),
      });
      await appendTestSessionMessage(sessionId, {
        role: "assistant",
        content: [{ type: "text", text: "seed assistant" }],
        stopReason: "stop",
        api: "openai-responses",
        provider: "openai",
        model: "mock-1",
        usage: createMockUsage(1, 1),
        timestamp: Date.now(),
      });
      await runDefaultEmbeddedTurn(sessionId, "hello", sessionKey);

      const messages = await readSessionMessages(sessionId);
      const seedUserIndex = messages.findIndex(
        (message) => message?.role === "user" && textFromContent(message.content) === "seed user",
      );
      const seedAssistantIndex = messages.findIndex(
        (message) =>
          message?.role === "assistant" && textFromContent(message.content) === "seed assistant",
      );
      expect(seedUserIndex).toBeGreaterThanOrEqual(0);
      expect(seedAssistantIndex).toBeGreaterThan(seedUserIndex);
      expect(messages.length).toBeGreaterThanOrEqual(2);
    },
  );

  it("repairs orphaned user messages and continues", async () => {
    const result = await runWithOrphanedSingleUserMessage("orphaned user", nextSessionKey());

    expect(result.meta.error).toBeUndefined();
    expect(result.payloads?.[0]?.text).toBe("ok");
  });
});
