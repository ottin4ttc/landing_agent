/**
 * Post-restart recovery for main sessions marked as interrupted.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizePendingFinalDeliveryText } from "../auto-reply/reply/pending-final-delivery.js";
import {
  type SessionEntry,
  getSessionEntry,
  listSessionEntries,
  resolveAgentIdFromSessionKey,
  upsertSessionEntry,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { readSessionMessagesAsync } from "../gateway/session-transcript-readers.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CommandLane } from "../process/lanes.js";
import { isAcpSessionKey, isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { listOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db.js";
import {
  deliveryContextFromSession,
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import type { SessionLockInspection } from "./session-write-lock.js";

const log = createSubsystemLogger("main-session-restart-recovery");

const DEFAULT_RECOVERY_DELAY_MS = 5_000;
const MAX_RECOVERY_RETRIES = 3;
const RETRY_BACKOFF_MULTIPLIER = 2;
const UNRESUMABLE_SESSION_NOTICE =
  "I was interrupted by a gateway restart and couldn't safely resume the previous turn. " +
  "Please send that last request again and I'll pick it up cleanly.";

function normalizeStringSet(values: Iterable<string> | undefined): Set<string> {
  const result = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed) {
      result.add(trimmed);
    }
  }
  return result;
}

function normalizeTranscriptLockPath(lockPath: string): string | undefined {
  const trimmed = lockPath.trim();
  if (!path.basename(trimmed).endsWith(".jsonl.lock")) {
    return undefined;
  }
  const resolved = path.resolve(trimmed);
  try {
    return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function resolveEntryTranscriptLockPaths(params: {
  entry: SessionEntry;
  sessionsDir: string;
}): string[] {
  const paths = new Set<string>();
  const push = (candidate: string | undefined) => {
    const trimmed = candidate?.trim();
    if (!trimmed) {
      return;
    }
    const transcriptPath = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(params.sessionsDir, trimmed);
    paths.add(`${transcriptPath}.lock`);
  };
  if (typeof params.entry.sessionId === "string" && params.entry.sessionId.trim()) {
    push(`${params.entry.sessionId}.jsonl`);
  }
  return [...paths];
}

function shouldSkipMainRecovery(entry: SessionEntry, sessionKey: string): boolean {
  if (typeof entry.spawnDepth === "number" && entry.spawnDepth > 0) {
    return true;
  }
  if (entry.subagentRole != null) {
    return true;
  }
  return (
    isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) || isAcpSessionKey(sessionKey)
  );
}

function getMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function isMeaningfulTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  if (!role || role === "system") {
    return false;
  }
  return true;
}

function isResumableTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  return role === "user" || role === "tool" || role === "toolResult";
}

function isApprovalPendingToolResult(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "toolResult") {
    return false;
  }
  const details = (message as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return false;
  }
  return (details as { status?: unknown }).status === "approval-pending";
}

function resolveMainSessionResumeBlockReason(messages: unknown[]): string | null {
  const lastMeaningful = messages.toReversed().find(isMeaningfulTailMessage);
  if (!lastMeaningful || !isResumableTailMessage(lastMeaningful)) {
    return "transcript tail is not resumable";
  }
  if (isApprovalPendingToolResult(lastMeaningful)) {
    return "transcript tail is a stale approval-pending tool result";
  }
  return null;
}

function buildResumeMessage(pendingFinalDeliveryText?: string | null): string {
  const base =
    "[System] Your previous turn was interrupted by a gateway restart while " +
    "OpenClaw was waiting on tool/model work. Continue from the existing " +
    "transcript and finish the interrupted response.";
  const sanitizedPendingText =
    typeof pendingFinalDeliveryText === "string"
      ? sanitizePendingFinalDeliveryText(pendingFinalDeliveryText)
      : "";
  if (sanitizedPendingText) {
    return `${base}\n\nNote: The interrupted final reply was captured: "${sanitizedPendingText}"`;
  }
  return base;
}

export async function markRestartAbortedMainSessions(params: {
  stateDir?: string;
  sessionKeys?: Iterable<string>;
  sessionIds?: Iterable<string>;
  reason?: string;
}): Promise<{ marked: number; skipped: number }> {
  const sessionKeys = normalizeStringSet(params.sessionKeys);
  const sessionIds = normalizeStringSet(params.sessionIds);
  const preferSessionIdMatch = sessionIds.size > 0;
  const result = { marked: 0, skipped: 0 };
  if (sessionKeys.size === 0 && sessionIds.size === 0) {
    return result;
  }

  const env = resolveRecoveryEnv(params.stateDir);
  for (const agentDatabase of listOpenClawRegisteredAgentDatabases({ env })) {
    for (const { sessionKey, entry } of listSessionEntries({
      agentId: agentDatabase.agentId,
      env,
      path: agentDatabase.path,
    })) {
      if (!entry || entry.status !== "running") {
        continue;
      }
      const matches =
        typeof entry.sessionId === "string" && sessionIds.has(entry.sessionId)
          ? true
          : !preferSessionIdMatch && sessionKeys.has(sessionKey);
      if (!matches) {
        continue;
      }
      if (shouldSkipMainRecovery(entry, sessionKey)) {
        result.skipped++;
        continue;
      }
      upsertSessionEntry({
        agentId: agentDatabase.agentId,
        env,
        path: agentDatabase.path,
        sessionKey,
        entry: {
          ...entry,
          abortedLastRun: true,
          updatedAt: Date.now(),
        },
      });
      result.marked++;
    }
  }

  if (result.marked > 0) {
    log.warn(
      `marked ${result.marked} interrupted main session(s) for restart recovery${
        params.reason ? ` (${params.reason})` : ""
      }`,
    );
  }
  return result;
}

export async function markRestartAbortedMainSessionsFromLocks(params: {
  sessionsDir: string;
  cleanedLocks: SessionLockInspection[];
}): Promise<{ marked: number; skipped: number }> {
  const result = { marked: 0, skipped: 0 };
  const sessionsDir = path.resolve(params.sessionsDir);
  const interruptedLockPaths = new Set(
    params.cleanedLocks
      .map((lock) => normalizeTranscriptLockPath(lock.lockPath))
      .filter((lockPath): lockPath is string => Boolean(lockPath)),
  );
  if (interruptedLockPaths.size === 0) {
    return result;
  }

  const env = resolveRecoveryEnv();
  for (const agentDatabase of listOpenClawRegisteredAgentDatabases({ env })) {
    for (const { sessionKey, entry } of listSessionEntries({
      agentId: agentDatabase.agentId,
      env,
      path: agentDatabase.path,
    })) {
      if (!entry || entry.status !== "running") {
        continue;
      }
      if (shouldSkipMainRecovery(entry, sessionKey)) {
        result.skipped++;
        continue;
      }
      const entryLockPaths = resolveEntryTranscriptLockPaths({ entry, sessionsDir });
      if (!entryLockPaths.some((lockPath) => interruptedLockPaths.has(lockPath))) {
        continue;
      }
      upsertSessionEntry({
        agentId: agentDatabase.agentId,
        env,
        path: agentDatabase.path,
        sessionKey,
        entry: {
          ...entry,
          abortedLastRun: true,
          updatedAt: Date.now(),
        },
      });
      result.marked++;
    }
  }

  if (result.marked > 0) {
    log.warn(`marked ${result.marked} interrupted main session(s) from stale transcript locks`);
  }
  return result;
}

async function markSessionFailed(params: {
  agentId: string;
  databasePath: string;
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  reason: string;
}): Promise<void> {
  const entry = getSessionEntry({
    agentId: params.agentId,
    env: params.env,
    path: params.databasePath,
    sessionKey: params.sessionKey,
  });
  if (!entry || entry.status !== "running") {
    return;
  }
  const now = Date.now();
  upsertSessionEntry({
    agentId: params.agentId,
    env: params.env,
    path: params.databasePath,
    sessionKey: params.sessionKey,
    entry: {
      ...entry,
      status: "failed",
      abortedLastRun: true,
      endedAt: now,
      updatedAt: now,
      pendingFinalDelivery: undefined,
      pendingFinalDeliveryText: undefined,
      pendingFinalDeliveryCreatedAt: undefined,
      pendingFinalDeliveryLastAttemptAt: undefined,
      pendingFinalDeliveryAttemptCount: undefined,
      pendingFinalDeliveryLastError: undefined,
      pendingFinalDeliveryContext: undefined,
      restartRecoveryDeliveryContext: undefined,
      restartRecoveryDeliveryRunId: undefined,
    },
  });
  log.warn(`marked interrupted main session failed: ${params.sessionKey} (${params.reason})`);
}

async function sendUnresumableSessionNotice(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  reason: string;
  sessionKey: string;
}): Promise<boolean> {
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    includeSessionDeliveryFallback: true,
    sessionKey: params.sessionKey,
  });
  if (!deliveryContext) {
    return false;
  }

  const messageParams: Record<string, unknown> = {
    to: deliveryContext.to,
    message: UNRESUMABLE_SESSION_NOTICE,
    bestEffort: true,
  };
  if (deliveryContext?.threadId != null) {
    messageParams.threadId = deliveryContext.threadId;
  }
  const actionParams: Record<string, unknown> = {
    channel: deliveryContext.channel,
    action: "send",
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    idempotencyKey: `main-session-restart-recovery:${params.entry.sessionId}:failed-notice`,
    params: messageParams,
  };
  const accountId = normalizeOptionalString(deliveryContext?.accountId);
  if (accountId) {
    actionParams.accountId = accountId;
  }

  try {
    await callGateway({
      method: "message.action",
      params: actionParams,
      timeoutMs: 10_000,
    });
    log.info(
      `sent interrupted main session recovery notice: ${params.sessionKey} (${params.reason})`,
    );
    return true;
  } catch (err) {
    log.warn(
      `failed to send interrupted main session recovery notice ${params.sessionKey}: ${String(err)}`,
    );
    return false;
  }
}

function resolveRestartRecoveryDeliveryContext(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  includeSessionDeliveryFallback?: boolean;
  sessionKey: string;
}): DeliveryContext | undefined {
  const deliveryContext =
    normalizeDeliveryContext(params.entry.pendingFinalDeliveryContext) ??
    normalizeDeliveryContext(params.entry.restartRecoveryDeliveryContext) ??
    (params.includeSessionDeliveryFallback ? deliveryContextFromSession(params.entry) : undefined);
  const channel = normalizeOptionalString(deliveryContext?.channel);
  const to = normalizeOptionalString(deliveryContext?.to);
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return undefined;
  }
  if (
    params.cfg &&
    resolveSendPolicy({
      cfg: params.cfg,
      entry: params.entry,
      sessionKey: params.sessionKey,
      channel,
      chatType: params.entry.chatType,
    }) === "deny"
  ) {
    return undefined;
  }
  return {
    ...deliveryContext,
    channel,
    to,
  };
}

async function resumeMainSession(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  databasePath: string;
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  pendingFinalDeliveryText?: string | null;
}): Promise<boolean> {
  const sanitizedPendingText =
    typeof params.pendingFinalDeliveryText === "string"
      ? sanitizePendingFinalDeliveryText(params.pendingFinalDeliveryText)
      : "";
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    sessionKey: params.sessionKey,
  });
  try {
    const agentParams: Record<string, unknown> = {
      message: buildResumeMessage(sanitizedPendingText),
      sessionKey: params.sessionKey,
      idempotencyKey: crypto.randomUUID(),
      deliver: Boolean(deliveryContext),
      lane: CommandLane.Main,
    };
    if (deliveryContext) {
      agentParams.channel = deliveryContext.channel;
      agentParams.to = deliveryContext.to;
      agentParams.bestEffortDeliver = true;
      if (deliveryContext.accountId) {
        agentParams.accountId = deliveryContext.accountId;
      }
      if (deliveryContext.threadId != null) {
        agentParams.threadId = String(deliveryContext.threadId);
      }
    }
    await callGateway<{ runId: string }>({
      method: "agent",
      params: agentParams,
      timeoutMs: 10_000,
    });
    const entry = getSessionEntry({
      agentId: params.agentId,
      env: params.env,
      path: params.databasePath,
      sessionKey: params.sessionKey,
    });
    if (entry) {
      const now = Date.now();
      const next: SessionEntry = {
        ...entry,
        abortedLastRun: false,
        updatedAt: now,
      };
      if (entry.pendingFinalDelivery || entry.pendingFinalDeliveryText) {
        if (sanitizedPendingText) {
          next.pendingFinalDeliveryLastAttemptAt = now;
          next.pendingFinalDeliveryAttemptCount = (entry.pendingFinalDeliveryAttemptCount ?? 0) + 1;
          next.pendingFinalDeliveryLastError = null;
          next.pendingFinalDeliveryText = sanitizedPendingText;
        } else {
          next.pendingFinalDelivery = undefined;
          next.pendingFinalDeliveryText = undefined;
          next.pendingFinalDeliveryCreatedAt = undefined;
          next.pendingFinalDeliveryLastAttemptAt = undefined;
          next.pendingFinalDeliveryAttemptCount = undefined;
          next.pendingFinalDeliveryLastError = undefined;
          next.pendingFinalDeliveryContext = undefined;
        }
      }
      upsertSessionEntry({
        agentId: params.agentId,
        env: params.env,
        path: params.databasePath,
        sessionKey: params.sessionKey,
        entry: next,
      });
    }
    log.info(
      `resumed interrupted main session: ${params.sessionKey}${
        sanitizedPendingText ? " (with pending payload)" : ""
      }`,
    );
    return true;
  } catch (err) {
    log.warn(`failed to resume interrupted main session ${params.sessionKey}: ${String(err)}`);
    return false;
  }
}

async function recoverStore(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  databasePath: string;
  env?: NodeJS.ProcessEnv;
  resumedSessionKeys: Set<string>;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  let rows: Array<{ sessionKey: string; entry: SessionEntry }>;
  try {
    rows = listSessionEntries({
      agentId: params.agentId,
      env: params.env,
      path: params.databasePath,
    });
  } catch (err) {
    log.warn(
      `failed to load session rows for agent ${params.agentId} at ${params.databasePath}: ${String(err)}`,
    );
    result.failed++;
    return result;
  }

  for (const { sessionKey, entry } of rows.toSorted((a, b) =>
    a.sessionKey.localeCompare(b.sessionKey),
  )) {
    if (!entry || entry.status !== "running" || entry.abortedLastRun !== true) {
      continue;
    }
    if (shouldSkipMainRecovery(entry, sessionKey)) {
      result.skipped++;
      continue;
    }
    if (params.resumedSessionKeys.has(sessionKey)) {
      result.skipped++;
      continue;
    }

    let messages: unknown[];
    try {
      messages = await readSessionMessagesAsync(
        {
          agentId: resolveAgentIdFromSessionKey(sessionKey),
          path: params.databasePath,
          sessionId: entry.sessionId,
        },
        {
          mode: "recent",
          maxMessages: 20,
          maxBytes: 256 * 1024,
        },
      );
    } catch (err) {
      log.warn(`failed to read transcript for ${sessionKey}: ${String(err)}`);
      result.failed++;
      continue;
    }

    const resumeBlockReason = resolveMainSessionResumeBlockReason(messages);
    if (resumeBlockReason) {
      await sendUnresumableSessionNotice({
        cfg: params.cfg,
        entry,
        sessionKey,
        reason: resumeBlockReason,
      });
      await markSessionFailed({
        agentId: params.agentId,
        databasePath: params.databasePath,
        env: params.env,
        sessionKey,
        reason: resumeBlockReason,
      });
      result.failed++;
      continue;
    }

    const resumed = await resumeMainSession({
      cfg: params.cfg,
      entry,
      agentId: params.agentId,
      databasePath: params.databasePath,
      env: params.env,
      sessionKey,
      pendingFinalDeliveryText: entry.pendingFinalDeliveryText,
    });
    if (resumed) {
      params.resumedSessionKeys.add(sessionKey);
      result.recovered++;
    } else {
      result.failed++;
    }
  }

  return result;
}

function resolveRecoveryEnv(stateDir?: string): NodeJS.ProcessEnv | undefined {
  return stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : undefined;
}

export async function recoverRestartAbortedMainSessions(
  params: {
    stateDir?: string;
    resumedSessionKeys?: Set<string>;
  } = {},
): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  const resumedSessionKeys = params.resumedSessionKeys ?? new Set<string>();
  const env = resolveRecoveryEnv(params.stateDir);
  const agentDatabases = listOpenClawRegisteredAgentDatabases({ env });

  for (const agentDatabase of agentDatabases) {
    const storeResult = await recoverStore({
      agentId: agentDatabase.agentId,
      databasePath: agentDatabase.path,
      env,
      resumedSessionKeys,
    });
    result.recovered += storeResult.recovered;
    result.failed += storeResult.failed;
    result.skipped += storeResult.skipped;
  }

  if (result.recovered > 0 || result.failed > 0) {
    log.info(
      `main-session restart recovery complete: recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`,
    );
  }
  return result;
}

export function scheduleRestartAbortedMainSessionRecovery(
  params: {
    delayMs?: number;
    maxRetries?: number;
    stateDir?: string;
  } = {},
): void {
  const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;
  const resumedSessionKeys = new Set<string>();

  const attemptRecovery = (attempt: number, delay: number) => {
    setTimeout(() => {
      void recoverRestartAbortedMainSessions({
        stateDir: params.stateDir,
        resumedSessionKeys,
      })
        .then((result) => {
          if (result.failed > 0 && attempt < maxRetries) {
            attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
          }
        })
        .catch((err) => {
          if (attempt < maxRetries) {
            log.warn(`main-session restart recovery failed: ${String(err)}`);
            attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
          } else {
            log.warn(`main-session restart recovery gave up: ${String(err)}`);
          }
        });
    }, delay).unref?.();
  };

  attemptRecovery(1, initialDelay);
}
