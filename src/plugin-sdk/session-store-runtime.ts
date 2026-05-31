// SQLite session row helpers plus deprecated session-store compatibility shims.

import fs from "node:fs";
import path from "node:path";
import type { MsgContext } from "../auto-reply/templating.js";
import { resolveStateDir } from "../config/paths.js";
import { loadSqliteSessionEntries } from "../config/sessions/session-entries.sqlite.js";
import { normalizeSessionEntries } from "../config/sessions/session-entry-normalize.js";
import { validateSessionId } from "../config/sessions/session-id.js";
import { resolveAndPersistSessionTranscriptScope } from "../config/sessions/session-scope.js";
import { resolveSessionRowEntry } from "../config/sessions/store-entry.js";
import {
  deleteSessionEntry,
  getSessionEntry as getInternalSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  readSessionUpdatedAt as readSqliteSessionUpdatedAt,
  recordSessionMetaFromInbound as recordSessionMetaFromInboundSqlite,
  updateLastRoute as updateLastRouteSqlite,
  upsertSessionEntry,
} from "../config/sessions/store.js";
import type { SessionEntry, SessionScope } from "../config/sessions/types.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { resolveUserPath } from "../utils.js";
import { writeJsonFileAtomically } from "./json-store.js";

export { closeOpenClawAgentDatabasesForTest };
export { resolveSessionRowEntry };
export { resolveAndPersistSessionTranscriptScope };
export { readLatestAssistantTextFromSessionTranscript } from "../config/sessions/transcript.js";
export { resolveSessionKey } from "../config/sessions/session-key.js";
export { resolveGroupSessionKey } from "../config/sessions/group.js";
export { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
export {
  appendSqliteSessionTranscriptEvent,
  hasSqliteSessionTranscriptEvents,
  loadSqliteSessionTranscriptBoundedEvents,
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
} from "../config/sessions/transcript-store.sqlite.js";
export { deleteSessionEntry, listSessionEntries, patchSessionEntry, upsertSessionEntry };
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../config/sessions/reset.js";
export type { SessionEntry, SessionScope };

type SessionRowOptions = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
};

type GetSessionEntryOptions = {
  agentId?: string;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
};

type SaveSessionStoreOptions = {
  skipMaintenance?: boolean;
  activeSessionKey?: string;
  allowDropAcpMetaSessionKeys?: string[];
  onWarn?: (warning: unknown) => void | Promise<void>;
  onMaintenanceApplied?: (report: unknown) => void | Promise<void>;
  maintenanceOverride?: unknown;
  maintenanceConfig?: unknown;
};

type CompatSessionEntry = SessionEntry & { sessionFile?: string };

type SessionFilePathOptions = {
  agentId?: string;
  sessionsDir?: string;
};

const legacySessionStoreWrites = new Map<string, Promise<void>>();

function optionsWithEnv(agentId: string, env?: NodeJS.ProcessEnv): SessionRowOptions {
  return env ? { agentId, env } : { agentId };
}

export function getSessionEntry(options: GetSessionEntryOptions): SessionEntry | undefined {
  return getInternalSessionEntry({
    ...options,
    agentId:
      options.agentId ?? resolveAgentIdFromSessionKey(options.sessionKey) ?? DEFAULT_AGENT_ID,
  });
}

function parseSessionStorePath(storePath: string): { agentId: string; stateDir: string } | null {
  const resolved = path.resolve(storePath);
  if (path.basename(resolved) !== "sessions.json") {
    return null;
  }
  const sessionsDir = path.dirname(resolved);
  if (path.basename(sessionsDir) !== "sessions") {
    return null;
  }
  const agentDir = path.dirname(sessionsDir);
  const agentsDir = path.dirname(agentDir);
  if (path.basename(agentsDir) !== "agents") {
    return null;
  }
  const agentId = path.basename(agentDir);
  if (!agentId) {
    return null;
  }
  return {
    agentId: normalizeAgentId(agentId),
    stateDir: path.dirname(agentsDir),
  };
}

function resolveSessionRowOptionsFromStorePath(
  storePath: string,
  fallback?: { agentId?: string; env?: NodeJS.ProcessEnv; sessionKey?: string },
): SessionRowOptions {
  const parsed = parseSessionStorePath(storePath);
  if (!parsed) {
    const agentId =
      fallback?.agentId ??
      (fallback?.sessionKey ? resolveAgentIdFromSessionKey(fallback.sessionKey) : undefined) ??
      DEFAULT_AGENT_ID;
    return optionsWithEnv(normalizeAgentId(agentId), fallback?.env);
  }
  return optionsWithEnv(parsed.agentId, {
    ...process.env,
    OPENCLAW_STATE_DIR: parsed.stateDir,
  });
}

function resolveSessionRowOptions(params: {
  agentId?: string;
  sessionKey?: string;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
}): SessionRowOptions {
  if (params.storePath) {
    const resolved = resolveSessionRowOptionsFromStorePath(params.storePath, params);
    return params.env
      ? optionsWithEnv(resolved.agentId, {
          ...params.env,
          OPENCLAW_STATE_DIR: resolved.env?.OPENCLAW_STATE_DIR,
        })
      : resolved;
  }
  const agentId =
    params.agentId ??
    (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined) ??
    DEFAULT_AGENT_ID;
  return optionsWithEnv(normalizeAgentId(agentId), params.env);
}

function readLegacySessionStoreJson(storePath: string): Record<string, SessionEntry> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(storePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, SessionEntry>;
  } catch {
    return null;
  }
}

async function runExclusiveLegacySessionStoreWrite<T>(
  storePath: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const key = path.resolve(storePath);
  const previous = legacySessionStoreWrites.get(key) ?? Promise.resolve();
  let releaseCurrent: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  legacySessionStoreWrites.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (legacySessionStoreWrites.get(key) === queued) {
      legacySessionStoreWrites.delete(key);
    }
  }
}

async function writeLegacySessionStoreJson(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  await writeJsonFileAtomically(storePath, store);
}

export function clearSessionStoreCacheForTest(): void {
  closeOpenClawAgentDatabasesForTest();
}

export function resolveSessionStoreEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
}): {
  normalizedKey: string;
  existing: SessionEntry | undefined;
  legacyKeys: string[];
} {
  const resolved = resolveSessionRowEntry({ entries: params.store, sessionKey: params.sessionKey });
  return { ...resolved, legacyKeys: [] };
}

export function resolveStorePath(
  store?: string,
  opts?: { agentId?: string; env?: NodeJS.ProcessEnv },
): string {
  const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);
  const env = opts?.env ?? process.env;
  if (!store) {
    return path.join(resolveStateDir(env), "agents", agentId, "sessions", "sessions.json");
  }
  return path.resolve(resolveUserPath(store.replaceAll("{agentId}", agentId), env));
}

function resolveSessionsDir(opts?: SessionFilePathOptions): string {
  const sessionsDir = opts?.sessionsDir?.trim();
  if (sessionsDir) {
    return path.resolve(sessionsDir);
  }
  return path.dirname(resolveStorePath(undefined, { agentId: opts?.agentId }));
}

function isCanonicalAgentSessionPath(candidate: string, agentId: string): boolean {
  const parts = path.resolve(candidate).split(path.sep).filter(Boolean);
  const sessionsIndex = parts.lastIndexOf("sessions");
  if (sessionsIndex < 2 || parts[sessionsIndex - 2] !== "agents") {
    return false;
  }
  if (normalizeAgentId(parts[sessionsIndex - 1] ?? "") !== normalizeAgentId(agentId)) {
    return false;
  }
  return parts.slice(sessionsIndex + 1).length === 1;
}

function resolvePathWithinSessionsDir(
  sessionsDir: string,
  candidate: string,
  opts?: { agentId?: string },
): string {
  const trimmed = candidate.trim();
  if (!trimmed) {
    throw new Error("Session file path must not be empty");
  }
  const resolvedBase = path.resolve(sessionsDir);
  const resolvedCandidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(resolvedBase, trimmed);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    const agentId = opts?.agentId?.trim();
    if (
      path.isAbsolute(trimmed) &&
      agentId &&
      isCanonicalAgentSessionPath(resolvedCandidate, agentId)
    ) {
      return resolvedCandidate;
    }
    throw new Error("Session file path must be within sessions directory");
  }
  return resolvedCandidate;
}

export function resolveSessionTranscriptPathInDir(
  sessionId: string,
  sessionsDir: string,
  topicId?: string | number,
): string {
  const trimmed = validateSessionId(sessionId);
  const safeTopicId =
    typeof topicId === "string"
      ? encodeURIComponent(topicId)
      : typeof topicId === "number"
        ? String(topicId)
        : undefined;
  const fileName =
    safeTopicId === undefined ? `${trimmed}.jsonl` : `${trimmed}-topic-${safeTopicId}.jsonl`;
  return path.resolve(sessionsDir, fileName);
}

/**
 * @deprecated Prefer SQLite transcript scope helpers. Kept for external plugin compatibility.
 */
export function resolveSessionFilePath(
  sessionId: string,
  entry?: { sessionFile?: string },
  opts?: SessionFilePathOptions,
): string {
  const sessionsDir = resolveSessionsDir(opts);
  const candidate = entry?.sessionFile?.trim();
  if (candidate) {
    try {
      return resolvePathWithinSessionsDir(sessionsDir, candidate, { agentId: opts?.agentId });
    } catch {
      // Fall back to the canonical transcript path when legacy metadata is stale.
    }
  }
  return resolveSessionTranscriptPathInDir(sessionId, sessionsDir);
}

export function loadSessionStore(
  storePath: string,
  _opts?: { skipCache?: boolean },
): Record<string, SessionEntry> {
  if (!parseSessionStorePath(storePath)) {
    return readLegacySessionStoreJson(storePath) ?? {};
  }
  const options = resolveSessionRowOptionsFromStorePath(storePath);
  const sqliteStore = loadSqliteSessionEntries(options);
  if (Object.keys(sqliteStore).length > 0) {
    return sqliteStore;
  }
  return readLegacySessionStoreJson(storePath) ?? sqliteStore;
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
  _opts?: SaveSessionStoreOptions,
): Promise<void> {
  normalizeSessionEntries(store);
  if (!parseSessionStorePath(storePath)) {
    await runExclusiveLegacySessionStoreWrite(storePath, () =>
      writeLegacySessionStoreJson(storePath, store),
    );
    return;
  }
  const options = resolveSessionRowOptionsFromStorePath(storePath);
  const deleteScope = new Set(Object.keys(loadSqliteSessionEntries(options)));
  await saveSessionStoreRows(options, store, deleteScope);
}

async function saveSessionStoreRows(
  options: SessionRowOptions,
  store: Record<string, SessionEntry>,
  deleteScope?: ReadonlySet<string>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(store)) {
    upsertSessionEntry({ ...options, sessionKey, entry });
  }
  if (deleteScope) {
    for (const sessionKey of deleteScope) {
      if (!Object.prototype.hasOwnProperty.call(store, sessionKey)) {
        deleteSessionEntry({ ...options, sessionKey });
      }
    }
  }
}

export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  _opts?: SaveSessionStoreOptions,
): Promise<T> {
  if (!parseSessionStorePath(storePath)) {
    return await runExclusiveLegacySessionStoreWrite(storePath, async () => {
      const store = readLegacySessionStoreJson(storePath) ?? {};
      const result = await mutator(store);
      normalizeSessionEntries(store);
      await writeLegacySessionStoreJson(storePath, store);
      return result;
    });
  }
  const options = resolveSessionRowOptionsFromStorePath(storePath);
  const sqliteStore = loadSqliteSessionEntries(options);
  const store =
    Object.keys(sqliteStore).length > 0
      ? sqliteStore
      : (readLegacySessionStoreJson(storePath) ?? sqliteStore);
  const deleteScope = new Set(Object.keys(store));
  const result = await mutator(store);
  normalizeSessionEntries(store);
  await saveSessionStoreRows(options, store, deleteScope);
  return result;
}

export async function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null> {
  if (!parseSessionStorePath(params.storePath)) {
    let nextEntry: SessionEntry | null = null;
    await updateSessionStore(params.storePath, async (store) => {
      const existing = store[params.sessionKey];
      if (!existing) {
        return;
      }
      const update = await params.update(existing);
      if (!update) {
        nextEntry = null;
        return;
      }
      nextEntry = { ...existing, ...update };
      store[params.sessionKey] = nextEntry;
    });
    return nextEntry;
  }
  const options = resolveSessionRowOptionsFromStorePath(params.storePath);
  return await patchSessionEntry({
    ...options,
    sessionKey: params.sessionKey,
    update: params.update,
  });
}

export async function resolveAndPersistSessionFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<string, CompatSessionEntry>;
  storePath: string;
  sessionEntry?: CompatSessionEntry;
  agentId?: string;
  sessionsDir?: string;
  fallbackSessionFile?: string;
  activeSessionKey?: string;
  maintenanceConfig?: unknown;
}): Promise<{ sessionFile: string; sessionEntry: CompatSessionEntry }> {
  const now = Date.now();
  const baseEntry = params.sessionEntry ??
    params.sessionStore[params.sessionKey] ?? {
      sessionId: params.sessionId,
      updatedAt: now,
      sessionStartedAt: now,
    };
  const persistedSessionFile =
    baseEntry.sessionId === params.sessionId ? baseEntry.sessionFile?.trim() : undefined;
  const sessionFile =
    persistedSessionFile ||
    params.fallbackSessionFile?.trim() ||
    resolveSessionTranscriptPathInDir(
      params.sessionId,
      params.sessionsDir ?? path.dirname(path.resolve(params.storePath)),
    );
  const sessionEntry: CompatSessionEntry = {
    ...baseEntry,
    sessionId: params.sessionId,
    sessionFile,
    updatedAt: now,
    sessionStartedAt:
      baseEntry.sessionId === params.sessionId ? (baseEntry.sessionStartedAt ?? now) : now,
  };
  params.sessionStore[params.sessionKey] = sessionEntry;
  upsertSessionEntry({
    ...resolveSessionRowOptions({
      storePath: params.storePath,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    }),
    sessionKey: params.sessionKey,
    entry: sessionEntry as SessionEntry,
  });
  return { sessionFile, sessionEntry };
}

export function readSessionUpdatedAt(params: {
  agentId?: string;
  storePath?: string;
  sessionKey: string;
}): number | undefined {
  return readSqliteSessionUpdatedAt({
    ...resolveSessionRowOptions(params),
    sessionKey: params.sessionKey,
  });
}

export async function recordSessionMetaFromInbound(params: {
  agentId?: string;
  storePath?: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("../config/sessions/types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  return await recordSessionMetaFromInboundSqlite({
    ...resolveSessionRowOptions(params),
    sessionKey: params.sessionKey,
    ctx: params.ctx,
    groupResolution: params.groupResolution,
    createIfMissing: params.createIfMissing,
  });
}

export async function updateLastRoute(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey: string;
  channel?: SessionEntry["channel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: import("../utils/delivery-context.types.js").DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("../config/sessions/types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  return await updateLastRouteSqlite({
    ...resolveSessionRowOptions(params),
    sessionKey: params.sessionKey,
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    threadId: params.threadId,
    deliveryContext: params.deliveryContext,
    ctx: params.ctx,
    groupResolution: params.groupResolution,
    createIfMissing: params.createIfMissing,
  });
}
