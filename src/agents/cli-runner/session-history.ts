import nodePath from "node:path";
import {
  loadSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScope,
} from "../../config/sessions/transcript-store.sqlite.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import {
  limitAgentHookHistoryMessages,
  MAX_AGENT_HOOK_HISTORY_MESSAGES,
} from "../harness/hook-history.js";
import type { AgentMessage } from "../runtime/index.js";
import { type TranscriptEntry } from "../transcript/session-transcript-contract.js";

export const MAX_CLI_SESSION_HISTORY_BYTES = 5 * 1024 * 1024;
export const MAX_CLI_SESSION_HISTORY_MESSAGES = MAX_AGENT_HOOK_HISTORY_MESSAGES;
export const MAX_CLI_SESSION_RESEED_HISTORY_CHARS = 12 * 1024;
export const MAX_AUTO_CLI_SESSION_RESEED_HISTORY_CHARS = 256 * 1024;
const CLI_SESSION_RESEED_HISTORY_CONTEXT_SHARE = 0.08;
const CHARS_PER_TOKEN_ESTIMATE = 4;

type HistoryMessage = {
  role?: unknown;
  content?: unknown;
  summary?: unknown;
};
type HistoryEntry = {
  type?: unknown;
  message?: unknown;
  summary?: unknown;
  content?: unknown;
  customType?: unknown;
  details?: unknown;
  display?: unknown;
  firstKeptEntryId?: unknown;
  fromId?: unknown;
  timestamp?: unknown;
  tokensAfter?: unknown;
  tokensBefore?: unknown;
};

type RawTranscriptReseedReason =
  | "auth-profile"
  | "auth-epoch"
  | "system-prompt"
  | "cwd"
  | "mcp"
  | "missing-transcript"
  | "orphaned-tool-use"
  | "session-expired";

const RAW_TRANSCRIPT_RESEED_ALLOWED_REASONS = new Set<RawTranscriptReseedReason>([
  "missing-transcript",
  "orphaned-tool-use",
  "system-prompt",
  "cwd",
  "mcp",
  "session-expired",
]);

export function resolveAutoCliSessionReseedHistoryChars(contextWindowTokens: number): number {
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return MAX_CLI_SESSION_RESEED_HISTORY_CHARS;
  }
  const contextShareChars = Math.floor(
    contextWindowTokens * CLI_SESSION_RESEED_HISTORY_CONTEXT_SHARE * CHARS_PER_TOKEN_ESTIMATE,
  );
  return Math.max(
    MAX_CLI_SESSION_RESEED_HISTORY_CHARS,
    Math.min(MAX_AUTO_CLI_SESSION_RESEED_HISTORY_CHARS, contextShareChars),
  );
}

function coerceHistoryText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : [];
    })
    .join("\n")
    .trim();
}

function coerceHistoryTimestamp(value: unknown): number | string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  return 0;
}

function historyEntryToContextEngineMessage(entry: HistoryEntry): AgentMessage | undefined {
  if (entry.type === "message") {
    return entry.message as AgentMessage;
  }
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: typeof entry.customType === "string" ? entry.customType : "custom",
      content: entry.content,
      display: entry.display !== false,
      details: entry.details,
      timestamp: coerceHistoryTimestamp(entry.timestamp),
    } as AgentMessage;
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: typeof entry.summary === "string" ? entry.summary : "",
      fromId: typeof entry.fromId === "string" ? entry.fromId : "root",
      timestamp: coerceHistoryTimestamp(entry.timestamp),
    } as AgentMessage;
  }
  return undefined;
}

function loadContextEngineMessagesFromEntries(entries: unknown[]): AgentMessage[] {
  return entries.flatMap((entry) => {
    const message = historyEntryToContextEngineMessage(entry as HistoryEntry);
    return message ? [message] : [];
  });
}

function renderHistoryMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as HistoryMessage;
  const role =
    entry.role === "assistant"
      ? "Assistant"
      : entry.role === "user"
        ? "User"
        : entry.role === "compactionSummary"
          ? "Compaction summary"
          : undefined;
  if (!role) {
    return undefined;
  }
  const text =
    entry.role === "compactionSummary" && typeof entry.summary === "string"
      ? entry.summary.trim()
      : coerceHistoryText(entry.content);
  return text ? `${role}: ${text}` : undefined;
}

export function buildCliSessionHistoryPrompt(params: {
  messages: unknown[];
  prompt: string;
  maxHistoryChars?: number;
}): string | undefined {
  const maxHistoryChars = params.maxHistoryChars ?? MAX_CLI_SESSION_RESEED_HISTORY_CHARS;

  // loadCliSessionReseedMessages deliberately places a `compactionSummary`
  // entry first when the session was compacted, so the compacted prior
  // context survives reseed. Pin that summary as a prefix and only
  // tail-truncate the post-summary transcript — a blind tail-slice of the
  // joined history would drop the summary whenever the post-summary tail
  // alone exceeds the cap.
  const firstEntry = params.messages[0];
  const firstIsCompaction =
    Boolean(firstEntry) &&
    typeof firstEntry === "object" &&
    (firstEntry as HistoryMessage).role === "compactionSummary";
  const summaryRendered = firstIsCompaction ? renderHistoryMessage(firstEntry) : undefined;
  const tailMessages = firstIsCompaction ? params.messages.slice(1) : params.messages;

  const tailRaw = tailMessages
    .flatMap((message) => {
      const rendered = renderHistoryMessage(message);
      return rendered ? [rendered] : [];
    })
    .join("\n\n")
    .trim();

  const truncationMarker = "[OpenClaw reseed history truncated; older turns dropped]";
  const renderTruncatedSummaryWithTail = (renderedSummary: string): string => {
    const tailBudget =
      tailRaw.length > 0 ? Math.min(tailRaw.length, Math.floor(maxHistoryChars / 2)) : 0;
    const separatorBudget = tailBudget > 0 ? 2 : 1;
    const summaryBudget = Math.max(
      0,
      maxHistoryChars - truncationMarker.length - separatorBudget - tailBudget,
    );
    const summaryTruncated = renderedSummary.slice(0, summaryBudget).trimEnd();
    const tailTruncated = tailBudget > 0 ? tailRaw.slice(-tailBudget).trimStart() : "";
    return [truncationMarker, summaryTruncated, tailTruncated].filter(Boolean).join("\n");
  };

  let renderedHistory: string;
  if (summaryRendered) {
    // Reserve the summary from the budget so the post-summary tail cap is
    // the remaining headroom. If the summary alone meets or exceeds the
    // cap, the summary itself must be truncated — pinning a summary that
    // blows past `maxHistoryChars` would defeat the cap that prevents
    // reseeding fresh CLI sessions with unexpectedly huge prompts.
    if (summaryRendered.length >= maxHistoryChars) {
      // Truncate the summary to fit the budget (less the marker line),
      // keeping the head. Still reserve budget for the post-summary tail so
      // recent exact turns survive even when the summary itself is oversize.
      renderedHistory = renderTruncatedSummaryWithTail(summaryRendered);
    } else if (tailRaw.length === 0) {
      renderedHistory = summaryRendered;
    } else {
      const summaryBlock = `${summaryRendered}\n\n`;
      const remainingBudget = maxHistoryChars - summaryBlock.length;
      if (remainingBudget <= 0) {
        // The summary plus separator already consumes the cap. Reuse the
        // oversize-summary path so recent post-summary turns still get
        // reserved tail budget instead of being dropped wholesale.
        renderedHistory = renderTruncatedSummaryWithTail(summaryRendered);
      } else if (tailRaw.length > remainingBudget) {
        renderedHistory = `${summaryBlock}${truncationMarker}\n${tailRaw.slice(-remainingBudget).trimStart()}`;
      } else {
        renderedHistory = `${summaryBlock}${tailRaw}`;
      }
    }
  } else {
    // No compaction summary to pin: tail-slice the full rendered history
    // and lead with the marker so it correctly describes what follows
    // (older turns dropped, recent tail retained).
    renderedHistory =
      tailRaw.length > maxHistoryChars
        ? `${truncationMarker}\n${tailRaw.slice(-maxHistoryChars).trimStart()}`
        : tailRaw;
  }

  if (!renderedHistory) {
    return undefined;
  }

  return [
    "Continue this conversation using the OpenClaw transcript below as prior session history.",
    "Treat it as authoritative context for this fresh CLI session.",
    "",
    "<conversation_history>",
    renderedHistory,
    "</conversation_history>",
    "",
    "<next_user_message>",
    params.prompt,
    "</next_user_message>",
  ].join("\n");
}

function resolveSafeCliTranscriptScope(params: {
  sessionId: string;
  sessionFile?: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): { agentId: string; path?: string; sessionId: string } {
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const agentId = sessionAgentId ?? defaultAgentId;
  const storeTarget = resolveCliTranscriptStoreTarget({
    agentId,
    storePath: params.config?.session?.store,
  });
  return {
    agentId: storeTarget.agentId,
    ...(storeTarget.databasePath ? { path: storeTarget.databasePath } : {}),
    sessionId: params.sessionId,
  };
}

function parseCanonicalSessionStorePath(
  storePath: string,
): { agentId: string; stateDir: string } | undefined {
  const resolved = nodePath.resolve(storePath);
  if (nodePath.basename(resolved) !== "sessions.json") {
    return undefined;
  }
  const sessionsDir = nodePath.dirname(resolved);
  if (nodePath.basename(sessionsDir) !== "sessions") {
    return undefined;
  }
  const agentDir = nodePath.dirname(sessionsDir);
  const agentsDir = nodePath.dirname(agentDir);
  if (nodePath.basename(agentsDir) !== "agents") {
    return undefined;
  }
  const agentId = nodePath.basename(agentDir);
  if (!agentId) {
    return undefined;
  }
  return {
    agentId: normalizeAgentId(agentId),
    stateDir: nodePath.dirname(agentsDir),
  };
}

function resolveCliTranscriptStoreTarget(params: { agentId: string; storePath?: string }): {
  agentId: string;
  databasePath?: string;
} {
  const agentId = normalizeAgentId(params.agentId);
  const storePath = params.storePath?.trim();
  if (!storePath || storePath === "(sqlite)") {
    return { agentId };
  }
  const parsed = parseCanonicalSessionStorePath(storePath);
  if (parsed) {
    return {
      agentId: parsed.agentId,
      databasePath: resolveOpenClawAgentSqlitePath({
        agentId: parsed.agentId,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: parsed.stateDir,
        },
      }),
    };
  }
  if (nodePath.extname(storePath) === ".json") {
    return { agentId };
  }
  return { agentId, databasePath: storePath };
}

async function loadCliSessionEntries(params: {
  sessionId: string;
  sessionFile?: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Promise<unknown[]> {
  try {
    const scope = resolveSqliteSessionTranscriptScope(resolveSafeCliTranscriptScope(params));
    if (!scope) {
      return [];
    }
    const entries = loadSqliteSessionTranscriptEvents(scope)
      .map((entry) => entry.event)
      .filter((entry): entry is TranscriptEntry => Boolean(entry && typeof entry === "object"));
    if (JSON.stringify(entries).length > MAX_CLI_SESSION_HISTORY_BYTES) {
      return [];
    }
    return entries.filter((entry) => entry.type !== "session");
  } catch {
    return [];
  }
}

export async function loadCliSessionHistoryMessages(params: {
  sessionId: string;
  sessionFile?: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Promise<unknown[]> {
  const history = (await loadCliSessionEntries(params)).flatMap((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "message" ? [candidate.message] : [];
  });
  return limitAgentHookHistoryMessages(history, MAX_CLI_SESSION_HISTORY_MESSAGES);
}

export async function loadCliSessionContextEngineMessages(params: {
  sessionId: string;
  sessionFile?: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Promise<unknown[]> {
  const entries = await loadCliSessionEntries(params);
  const latestCompactionIndex = entries.findLastIndex((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "compaction" && typeof candidate.summary === "string";
  });
  if (latestCompactionIndex < 0) {
    return loadContextEngineMessagesFromEntries(entries);
  }

  const compaction = entries[latestCompactionIndex] as HistoryEntry;
  const summary = typeof compaction.summary === "string" ? compaction.summary.trim() : "";
  if (!summary) {
    return loadContextEngineMessagesFromEntries(entries);
  }

  const tailMessages = loadContextEngineMessagesFromEntries(
    entries.slice(latestCompactionIndex + 1),
  );
  return [
    {
      role: "compactionSummary",
      summary,
      timestamp: coerceHistoryTimestamp(compaction.timestamp),
      tokensBefore: typeof compaction.tokensBefore === "number" ? compaction.tokensBefore : 0,
      ...(typeof compaction.tokensAfter === "number"
        ? { tokensAfter: compaction.tokensAfter }
        : {}),
      ...(typeof compaction.firstKeptEntryId === "string"
        ? { firstKeptEntryId: compaction.firstKeptEntryId }
        : {}),
      ...(compaction.details !== undefined ? { details: compaction.details } : {}),
    },
    ...tailMessages,
  ];
}

export async function hasCliSessionTranscript(params: {
  sessionId: string;
  sessionFile?: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Promise<boolean> {
  return (await loadCliSessionEntries(params)).length > 0;
}

export async function loadCliSessionReseedMessages(params: {
  sessionId: string;
  sessionFile?: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
  allowRawTranscriptReseed?: boolean;
  rawTranscriptReseedReason?: RawTranscriptReseedReason;
}): Promise<unknown[]> {
  const entries = await loadCliSessionEntries(params);
  const loadRawTail = () => {
    if (
      params.allowRawTranscriptReseed !== true ||
      !params.rawTranscriptReseedReason ||
      !RAW_TRANSCRIPT_RESEED_ALLOWED_REASONS.has(params.rawTranscriptReseedReason)
    ) {
      return [];
    }
    const rawTail = entries.flatMap((entry) => {
      const candidate = entry as HistoryEntry;
      return candidate.type === "message" ? [candidate.message] : [];
    });
    return limitAgentHookHistoryMessages(rawTail, MAX_CLI_SESSION_HISTORY_MESSAGES);
  };
  const latestCompactionIndex = entries.findLastIndex((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "compaction" && typeof candidate.summary === "string";
  });
  if (latestCompactionIndex < 0) {
    return loadRawTail();
  }

  const compaction = entries[latestCompactionIndex] as HistoryEntry;
  const summary = typeof compaction.summary === "string" ? compaction.summary.trim() : "";
  if (!summary) {
    return loadRawTail();
  }

  const tailMessages = entries.slice(latestCompactionIndex + 1).flatMap((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "message" ? [candidate.message] : [];
  });
  return [
    {
      role: "compactionSummary",
      summary,
    },
    ...limitAgentHookHistoryMessages(tailMessages, MAX_CLI_SESSION_HISTORY_MESSAGES - 1),
  ];
}
