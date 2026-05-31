import { randomUUID } from "node:crypto";
import {
  appendSqliteSessionTranscriptEvent,
  appendSqliteSessionTranscriptMessage,
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScope,
} from "../../config/sessions/transcript-store.sqlite.js";
import { CURRENT_SESSION_VERSION } from "./session-transcript-format.js";
import type { SessionEntry, SessionHeader, TranscriptEntry } from "./session-transcript-types.js";
import { TranscriptState, transcriptStateFromEntries } from "./transcript-state.js";

export type { TranscriptState } from "./transcript-state.js";

export type TranscriptPersistenceScope = {
  agentId: string;
  path?: string;
  sessionId: string;
};

function createSessionHeader(params: { id?: string; cwd: string }): SessionHeader {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.id ?? randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.cwd,
  };
}

function transcriptStateFromSqliteScope(
  scope: TranscriptPersistenceScope,
): TranscriptState | undefined {
  const events = loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
  if (events.length === 0) {
    return undefined;
  }
  return transcriptStateFromEntries(
    events.filter((event): event is TranscriptEntry => Boolean(event && typeof event === "object")),
  );
}

function resolveTranscriptWriteScopeForSession(
  scope: TranscriptPersistenceScope,
  entries: Array<SessionHeader | SessionEntry>,
): TranscriptPersistenceScope | undefined {
  const resolved = resolveSqliteSessionTranscriptScope(scope);
  if (!resolved) {
    return undefined;
  }
  const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
  const sessionId = header?.id ?? resolved.sessionId;
  if (!sessionId) {
    return undefined;
  }
  return {
    agentId: resolved.agentId,
    ...(resolved.path ? { path: resolved.path } : {}),
    sessionId,
  };
}

export async function readTranscriptStateForSession(
  scope: TranscriptPersistenceScope,
): Promise<TranscriptState> {
  const resolved = resolveSqliteSessionTranscriptScope(scope);
  const sqliteState = resolved ? transcriptStateFromSqliteScope(resolved) : undefined;
  if (sqliteState) {
    return sqliteState;
  }
  throw new Error(
    `Transcript is not in the SQLite state database for agent ${scope.agentId} session ${scope.sessionId}. Run "openclaw doctor --fix" if legacy files still need import.`,
  );
}

export function readTranscriptStateForSessionSync(
  scope: TranscriptPersistenceScope,
): TranscriptState {
  const resolved = resolveSqliteSessionTranscriptScope(scope);
  const sqliteState = resolved ? transcriptStateFromSqliteScope(resolved) : undefined;
  if (sqliteState) {
    return sqliteState;
  }
  throw new Error(
    `Transcript is not in the SQLite state database for agent ${scope.agentId} session ${scope.sessionId}. Run "openclaw doctor --fix" if legacy files still need import.`,
  );
}

export function loadOrCreateTranscriptStateForSession(params: {
  agentId: string;
  path?: string;
  sessionId: string;
  cwd?: string;
}): {
  scope: TranscriptPersistenceScope;
  state: TranscriptState;
} {
  const resolved = resolveSqliteSessionTranscriptScope(params);
  if (!resolved) {
    throw new Error(
      `Cannot resolve SQLite transcript scope for agent ${params.agentId} session ${params.sessionId}`,
    );
  }
  const sqliteState = transcriptStateFromSqliteScope(resolved);
  if (sqliteState) {
    return { scope: resolved, state: sqliteState };
  }

  const header = createSessionHeader({
    id: resolved.sessionId,
    cwd: params.cwd ?? process.cwd(),
  });
  const state = new TranscriptState({ header, entries: [] });
  replaceTranscriptStateForSession({ scope: resolved, state });
  return { scope: resolved, state };
}

export function replaceTranscriptStateForSession(params: {
  scope: TranscriptPersistenceScope;
  state: TranscriptState;
}): void {
  replaceSqliteSessionTranscriptEvents({
    agentId: params.scope.agentId,
    ...(params.scope.path ? { path: params.scope.path } : {}),
    sessionId: params.scope.sessionId,
    events: [...(params.state.header ? [params.state.header] : []), ...params.state.entries],
  });
}

export function appendMessageToTranscriptSession(params: {
  cwd: string;
  message: Parameters<TranscriptState["appendMessage"]>[0];
  scope: TranscriptPersistenceScope;
  sessionVersion: number;
}): string {
  const result = appendSqliteSessionTranscriptMessage({
    agentId: params.scope.agentId,
    ...(params.scope.path ? { path: params.scope.path } : {}),
    sessionId: params.scope.sessionId,
    sessionVersion: params.sessionVersion,
    cwd: params.cwd,
    message: params.message,
  });
  return result.messageId;
}

export function appendEntryToTranscriptSession(params: {
  entry: SessionEntry;
  parentMode?: "database-tail";
  scope: TranscriptPersistenceScope;
}): void {
  appendSqliteSessionTranscriptEvent({
    agentId: params.scope.agentId,
    ...(params.scope.path ? { path: params.scope.path } : {}),
    sessionId: params.scope.sessionId,
    event: params.entry,
    ...(params.parentMode ? { parentMode: params.parentMode } : {}),
  });
}

export async function persistTranscriptStateMutationForSession(params: {
  agentId: string;
  path?: string;
  sessionId: string;
  state: TranscriptState;
  appendedEntries: SessionEntry[];
}): Promise<void> {
  persistTranscriptStateMutationForSessionSync(params);
}

export function persistTranscriptStateMutationForSessionSync(params: {
  agentId: string;
  path?: string;
  sessionId: string;
  state: TranscriptState;
  appendedEntries: SessionEntry[];
}): void {
  if (params.appendedEntries.length === 0) {
    return;
  }
  const allEntries = [
    ...(params.state.header ? [params.state.header] : []),
    ...params.state.entries,
  ];
  const scope = resolveTranscriptWriteScopeForSession(params, allEntries);
  if (!scope) {
    throw new Error(
      `Cannot append SQLite transcript without a session header for agent ${params.agentId} session ${params.sessionId}`,
    );
  }
  for (const entry of params.appendedEntries) {
    appendSqliteSessionTranscriptEvent({ ...scope, event: entry });
  }
}

export function removeTailEntriesFromSqliteTranscript(params: {
  agentId: string;
  path?: string;
  sessionId: string;
  shouldRemove: (entry: SessionEntry) => boolean;
  options?: { maxEntries?: number; minEntries?: number };
}): number {
  const state = readTranscriptStateForSessionSync({
    agentId: params.agentId,
    path: params.path,
    sessionId: params.sessionId,
  });
  const removed = state.removeTailEntries(params.shouldRemove, params.options);
  if (removed === 0) {
    return 0;
  }
  replaceSqliteSessionTranscriptEvents({
    agentId: params.agentId,
    ...(params.path ? { path: params.path } : {}),
    sessionId: params.sessionId,
    events: [...(state.header ? [state.header] : []), ...state.entries],
  });
  return removed;
}
