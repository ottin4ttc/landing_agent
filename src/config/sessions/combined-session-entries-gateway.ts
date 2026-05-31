import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  canonicalizeSpawnedByForAgent,
  resolveStoredSessionRowKeyForAgent,
} from "../../gateway/session-row-key.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentMainSessionKey } from "./main-session.js";
import { listSessionEntries } from "./store.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveAgentSessionDatabaseTargetsSync,
  resolveAllAgentSessionDatabaseTargetsSync,
} from "./targets.js";
import type { SessionEntry } from "./types.js";

function resolveCombinedSessionEntryKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string {
  const storageAgentId = normalizeAgentId(params.agentId);
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (
    storageAgentId === defaultAgentId &&
    parsed &&
    normalizeAgentId(parsed.agentId) === DEFAULT_AGENT_ID &&
    normalizeMainKey(parsed.rest) === normalizeMainKey(params.cfg.session?.mainKey)
  ) {
    return resolveAgentMainSessionKey({ cfg: params.cfg, agentId: storageAgentId });
  }

  return resolveStoredSessionRowKeyForAgent(params);
}

function mergeSessionEntryIntoCombined(params: {
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  sourceDatabasePathBySessionKey: Record<string, string>;
  sourceAgentIdBySessionKey: Record<string, string>;
  sourceDatabasePath: string;
  entry: SessionEntry;
  agentId: string;
  canonicalKey: string;
}) {
  const { cfg, combined, entry, agentId, canonicalKey } = params;
  const existing = combined[canonicalKey];

  if (existing && (existing.updatedAt ?? 0) > (entry.updatedAt ?? 0)) {
    const spawnedBy = canonicalizeSpawnedByForAgent(
      cfg,
      agentId,
      existing.spawnedBy ?? entry.spawnedBy,
    );
    combined[canonicalKey] = {
      ...entry,
      ...existing,
      spawnedBy,
    };
    return;
  }

  const spawnedBy = canonicalizeSpawnedByForAgent(
    cfg,
    agentId,
    entry.spawnedBy ?? existing?.spawnedBy,
  );
  if (!existing && entry.spawnedBy === spawnedBy) {
    combined[canonicalKey] = entry;
  } else {
    combined[canonicalKey] = {
      ...existing,
      ...entry,
      spawnedBy,
    };
  }
  params.sourceDatabasePathBySessionKey[canonicalKey] = params.sourceDatabasePath;
  params.sourceAgentIdBySessionKey[canonicalKey] = agentId;
}

export function loadCombinedSessionEntriesForGateway(
  cfg: OpenClawConfig,
  opts: { agentId?: string; configuredAgentsOnly?: boolean } = {},
): {
  databasePath: string;
  entries: Record<string, SessionEntry>;
  sourceDatabasePathBySessionKey?: Record<string, string>;
  sourceAgentIdBySessionKey?: Record<string, string>;
} {
  const requestedAgentId =
    typeof opts.agentId === "string" && opts.agentId.trim()
      ? normalizeAgentId(opts.agentId)
      : undefined;
  const targets = requestedAgentId
    ? resolveAgentSessionDatabaseTargetsSync(cfg, requestedAgentId)
    : opts.configuredAgentsOnly === true
      ? listConfiguredSessionStoreAgentIds(cfg).flatMap((agentId) =>
          resolveAgentSessionDatabaseTargetsSync(cfg, normalizeAgentId(agentId)),
        )
      : resolveAllAgentSessionDatabaseTargetsSync(cfg);
  const combined: Record<string, SessionEntry> = {};
  const sourceDatabasePathBySessionKey: Record<string, string> = {};
  const sourceAgentIdBySessionKey: Record<string, string> = {};
  for (const target of targets) {
    const agentId = target.agentId;
    for (const { sessionKey: key, entry } of listSessionEntries({
      agentId,
      path: target.databasePath,
    })) {
      const canonicalKey = resolveCombinedSessionEntryKey({
        cfg,
        agentId,
        sessionKey: key,
      });
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        sourceDatabasePathBySessionKey,
        sourceAgentIdBySessionKey,
        sourceDatabasePath: target.databasePath,
        entry,
        agentId,
        canonicalKey,
      });
    }
  }

  const databasePath =
    requestedAgentId && targets.length > 0
      ? targets[0].databasePath
      : targets.length === 1
        ? targets[0].databasePath
        : "(multiple)";
  return {
    databasePath,
    entries: combined,
    sourceDatabasePathBySessionKey,
    sourceAgentIdBySessionKey,
  };
}
