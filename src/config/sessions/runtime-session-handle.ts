import type { PersistableSessionMessage } from "../../agents/transcript/session-transcript-types.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAndPersistSessionTranscriptScope } from "./session-scope.js";
import { getSessionEntry, normalizeSessionRowKey } from "./store.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";
import type { SessionEntry } from "./types.js";

type RuntimeAssistantTranscriptMessage = PersistableSessionMessage & {
  role: "assistant";
};

export type RuntimeSessionHandle = {
  agentId: string;
  databasePath?: string;
  sessionEntry: SessionEntry;
  sessionId: string;
  sessionKey: string;
};

export type OpenRuntimeSessionHandleOptions = {
  agentId: string;
  databasePath?: string;
  sessionKey: string;
};

export async function openRuntimeSessionHandle(
  options: OpenRuntimeSessionHandleOptions,
): Promise<RuntimeSessionHandle | null> {
  const sessionKey = normalizeSessionRowKey(options.sessionKey);
  const rowOptions = {
    agentId: options.agentId,
    ...(options.databasePath ? { path: options.databasePath } : {}),
  };
  const sessionEntry = getSessionEntry({
    ...rowOptions,
    sessionKey,
  });
  if (!sessionEntry?.sessionId) {
    return null;
  }

  const resolved = await resolveAndPersistSessionTranscriptScope({
    sessionId: sessionEntry.sessionId,
    sessionKey,
    sessionEntry,
    agentId: options.agentId,
    ...(options.databasePath ? { path: options.databasePath } : {}),
  });

  return {
    agentId: resolved.agentId,
    ...(options.databasePath ? { databasePath: options.databasePath } : {}),
    sessionEntry: resolved.sessionEntry,
    sessionId: resolved.sessionId,
    sessionKey,
  };
}

export async function appendAssistantMessageToRuntimeSession(params: {
  config?: OpenClawConfig;
  dedupeLatestAssistantText?: string;
  handle: RuntimeSessionHandle;
  message: RuntimeAssistantTranscriptMessage;
}): Promise<{ messageId: string; message: unknown }> {
  return await appendSessionTranscriptMessage({
    agentId: params.handle.agentId,
    ...(params.handle.databasePath ? { path: params.handle.databasePath } : {}),
    ...(params.dedupeLatestAssistantText
      ? { dedupeLatestAssistantText: params.dedupeLatestAssistantText }
      : {}),
    message: params.message,
    sessionId: params.handle.sessionId,
    config: params.config,
  });
}
