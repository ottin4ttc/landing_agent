import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSqliteSessionTranscriptEvents } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { runMSTeamsFeedbackInvokeHandler } from "./feedback-invoke.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.js";
import { createMSTeamsMessageHandlerDeps } from "./monitor-handler.test-helpers.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const feedbackReflectionMockState = vi.hoisted(() => ({
  runFeedbackReflection: vi.fn(),
}));

vi.mock("./monitor-handler/message-handler.js", () => ({
  createMSTeamsMessageHandler: () => async () => {},
}));

vi.mock("./monitor-handler/reaction-handler.js", () => ({
  createMSTeamsReactionHandler: () => async () => {},
}));

vi.mock("./feedback-reflection.js", async () => {
  const actual = await vi.importActual<typeof import("./feedback-reflection.js")>(
    "./feedback-reflection.js",
  );
  return {
    ...actual,
    runFeedbackReflection: feedbackReflectionMockState.runFeedbackReflection,
  };
});

function createRuntimeStub(readAllowFromStore: ReturnType<typeof vi.fn>): PluginRuntime {
  return {
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: () => ({
          enqueue: async () => {},
          flushKey: async () => {},
          cancelKey: () => false,
        }),
      },
      pairing: {
        readAllowFromStore,
        upsertPairingRequest: vi.fn(async () => null),
      },
      routing: {
        resolveAgentRoute: ({ peer }: { peer: { kind: string; id: string } }) => ({
          sessionKey: `msteams:${peer.kind}:${peer.id}`,
          agentId: "default",
        }),
      },
      session: {
        resolveStorePath: (storePath?: string) => storePath ?? tmpdir(),
      },
    },
  } as unknown as PluginRuntime;
}

function createDeps(params: {
  cfg: OpenClawConfig;
  readAllowFromStore?: ReturnType<typeof vi.fn>;
}): MSTeamsMessageHandlerDeps {
  const readAllowFromStore = params.readAllowFromStore ?? vi.fn(async () => []);
  setMSTeamsRuntime(createRuntimeStub(readAllowFromStore));
  return createMSTeamsMessageHandlerDeps({
    cfg: params.cfg,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
  });
}

function createFeedbackInvokeContext(params: {
  reaction: "like" | "dislike";
  conversationId: string;
  conversationType: string;
  senderId: string;
  senderName?: string;
  teamId?: string;
  channelName?: string;
  comment?: string;
}): MSTeamsTurnContext {
  return {
    activity: {
      id: `invoke-${params.reaction}`,
      type: "invoke",
      name: "message/submitAction",
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: {
        id: `${params.senderId}-botframework`,
        aadObjectId: params.senderId,
        name: params.senderName ?? "Sender",
      },
      recipient: {
        id: "bot-id",
        name: "Bot",
      },
      conversation: {
        id: params.conversationId,
        conversationType: params.conversationType,
        tenantId: params.teamId ? "tenant-1" : undefined,
      },
      channelData: params.teamId
        ? {
            team: { id: params.teamId, name: "Team 1" },
            channel: params.channelName ? { name: params.channelName } : undefined,
          }
        : {},
      value: {
        actionName: "feedback",
        actionValue: {
          reaction: params.reaction,
          feedback: JSON.stringify({ feedbackText: params.comment ?? "feedback text" }),
        },
        replyToId: "bot-msg-1",
      },
    },
    sendActivity: vi.fn(async () => ({ id: "ignored" })),
    sendActivities: async () => [],
  } as unknown as MSTeamsTurnContext;
}

function readFeedbackTranscriptMessage(params: {
  stateDir: string;
  sessionId: string;
}): Record<string, unknown> | undefined {
  const events = loadSqliteSessionTranscriptEvents({
    env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
    agentId: "default",
    sessionId: params.sessionId,
  });
  const messageEvent = events
    .map((entry) => entry.event)
    .find((entry) => {
      return Boolean(
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as { type?: unknown }).type === "message" &&
        (entry as { message?: { event?: unknown } }).message?.event === "feedback",
      );
    }) as { message?: Record<string, unknown> } | undefined;
  return messageEvent?.message;
}

async function withFeedbackHandler(params: {
  cfg: OpenClawConfig;
  context: Parameters<typeof createFeedbackInvokeContext>[0];
  sessionKey?: string;
  sessionId?: string;
  assertResult: (args: { tmpDir: string }) => Promise<void>;
}) {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "openclaw-msteams-feedback-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  try {
    if (params.sessionKey && params.sessionId) {
      upsertSessionEntry({
        agentId: "default",
        env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir },
        sessionKey: params.sessionKey,
        entry: {
          sessionId: params.sessionId,
          updatedAt: Date.now(),
        },
      });
    }
    const deps = createDeps({
      cfg: {
        ...params.cfg,
        session: {},
      },
    });
    await runMSTeamsFeedbackInvokeHandler(createFeedbackInvokeContext(params.context), deps);
    await params.assertResult({ tmpDir });
  } finally {
    resetPluginStateStoreForTests();
    if (previousStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await rm(tmpDir, { recursive: true, force: true });
  }
}

describe("msteams feedback invoke authz", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    feedbackReflectionMockState.runFeedbackReflection.mockReset();
    feedbackReflectionMockState.runFeedbackReflection.mockResolvedValue(undefined);
  });

  it("records feedback for an allowlisted DM sender", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "owner-aad",
        senderName: "Owner",
        comment: "allowed feedback",
      },
      sessionKey: "msteams:direct:owner-aad",
      sessionId: "owner-session",
      assertResult: async ({ tmpDir }) => {
        const event = readFeedbackTranscriptMessage({
          stateDir: tmpDir,
          sessionId: "owner-session",
        });
        if (!event) {
          throw new Error("expected feedback transcript event");
        }
        expect(Object.keys(event).toSorted()).toEqual([
          "agentId",
          "comment",
          "conversationId",
          "event",
          "messageId",
          "sessionKey",
          "ts",
          "type",
          "value",
        ]);
        expect(typeof event.ts).toBe("number");
        expect({ ...event, ts: 0 }).toEqual({
          type: "custom",
          event: "feedback",
          ts: 0,
          messageId: "bot-msg-1",
          value: "positive",
          comment: "allowed feedback",
          sessionKey: "msteams:direct:owner-aad",
          agentId: "default",
          conversationId: "a:personal-chat",
        });
      },
    });
  });

  it("keeps DM feedback allowed when team route allowlists exist", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
            teams: {
              team123: {
                channels: {
                  "19:group@thread.tacv2": { requireMention: false },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "owner-aad",
        senderName: "Owner",
        comment: "allowed dm feedback",
      },
      sessionKey: "msteams:direct:owner-aad",
      sessionId: "owner-session",
      assertResult: async ({ tmpDir }) => {
        const event = readFeedbackTranscriptMessage({
          stateDir: tmpDir,
          sessionId: "owner-session",
        });
        if (!event) {
          throw new Error("expected feedback transcript event");
        }
        expect(Object.keys(event).toSorted()).toEqual([
          "agentId",
          "comment",
          "conversationId",
          "event",
          "messageId",
          "sessionKey",
          "ts",
          "type",
          "value",
        ]);
        expect(typeof event.ts).toBe("number");
        expect({ ...event, ts: 0 }).toEqual({
          type: "custom",
          event: "feedback",
          ts: 0,
          messageId: "bot-msg-1",
          value: "positive",
          comment: "allowed dm feedback",
          sessionKey: "msteams:direct:owner-aad",
          agentId: "default",
          conversationId: "a:personal-chat",
        });
      },
    });
  });

  it("does not record feedback for a DM sender outside allowFrom", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "attacker-aad",
        senderName: "Attacker",
        comment: "blocked feedback",
      },
      sessionKey: "msteams:direct:attacker-aad",
      sessionId: "attacker-session",
      assertResult: async ({ tmpDir }) => {
        expect(
          readFeedbackTranscriptMessage({
            stateDir: tmpDir,
            sessionId: "attacker-session",
          }),
        ).toBeUndefined();
        expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
      },
    });
  });

  it("does not trigger reflection for a group sender outside groupAllowFrom", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["owner-aad"],
            feedbackReflection: true,
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "dislike",
        conversationId: "19:group@thread.tacv2;messageid=bot-msg-1",
        conversationType: "groupChat",
        senderId: "attacker-aad",
        senderName: "Attacker",
        teamId: "team-1",
        channelName: "General",
        comment: "blocked reflection",
      },
      sessionKey: "msteams:group:19:group@thread.tacv2",
      sessionId: "group-session",
      assertResult: async ({ tmpDir }) => {
        expect(
          readFeedbackTranscriptMessage({
            stateDir: tmpDir,
            sessionId: "group-session",
          }),
        ).toBeUndefined();
        expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
      },
    });
  });
});
