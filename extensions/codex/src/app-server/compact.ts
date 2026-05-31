import {
  compactContextEngineWithSafetyTimeout,
  embeddedAgentLog,
  formatErrorMessage,
  resolveCompactionTimeoutMs,
  runHarnessContextEngineMaintenance,
  type CompactEmbeddedAgentSessionParams,
  type EmbeddedAgentCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  defaultCodexAppServerClientFactory,
  type CodexAppServerClientFactory,
} from "./client-factory.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import type { JsonObject } from "./protocol.js";
import { resolveCodexNativeExecutionBlock } from "./sandbox-guard.js";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  type CodexAppServerBindingIdentity,
} from "./session-binding.js";

const warnedIgnoredCompactionOverrides = new Set<string>();

export async function maybeCompactCodexAppServerSession(
  params: CompactEmbeddedAgentSessionParams,
  options: { pluginConfig?: unknown; clientFactory?: CodexAppServerClientFactory } = {},
): Promise<EmbeddedAgentCompactResult | undefined> {
  warnIfIgnoringOpenClawCompactionOverrides(params);
  if (params.contextEngine?.info.ownsCompaction === true) {
    return compactOwningContextEngine(params, params.contextEngine);
  }
  return compactCodexNativeThread(params, options);
}

async function compactOwningContextEngine(
  params: CompactEmbeddedAgentSessionParams,
  contextEngine: NonNullable<CompactEmbeddedAgentSessionParams["contextEngine"]>,
): Promise<EmbeddedAgentCompactResult> {
  const compactionTarget = params.trigger === "manual" ? "threshold" : "budget";
  const force = params.force === true || params.trigger === "manual";
  embeddedAgentLog.info("starting context-engine-owned Codex app-server compaction", {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    engineId: contextEngine.info.id,
    tokenBudget: params.contextTokenBudget,
    currentTokenCount: params.currentTokenCount,
    trigger: params.trigger,
    compactionTarget,
    force,
  });
  let result: Awaited<ReturnType<typeof contextEngine.compact>>;
  try {
    result = await compactContextEngineWithSafetyTimeout(
      contextEngine,
      {
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        transcriptScope: buildContextEngineTranscriptScope(params),
        tokenBudget: params.contextTokenBudget,
        currentTokenCount: params.currentTokenCount,
        compactionTarget,
        customInstructions: params.customInstructions,
        force,
        runtimeContext: params.contextEngineRuntimeContext,
      },
      resolveCompactionTimeoutMs(params.config),
      params.abortSignal,
    );
  } catch (error) {
    embeddedAgentLog.warn("context-engine-owned Codex app-server compaction failed", {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      engineId: contextEngine.info.id,
      error: formatErrorMessage(error),
    });
    return {
      ok: false,
      compacted: false,
      reason: `context engine compaction failed: ${formatErrorMessage(error)}`,
    };
  }

  if (result.ok && result.compacted) {
    const compactedSessionId = result.result?.sessionId ?? params.sessionId;
    try {
      await runHarnessContextEngineMaintenance({
        contextEngine,
        sessionId: compactedSessionId,
        sessionKey: params.sessionKey,
        transcriptScope: buildContextEngineTranscriptScope({
          ...params,
          sessionId: compactedSessionId,
        }),
        reason: "compaction",
        runtimeContext: params.contextEngineRuntimeContext,
        config: params.config,
      });
    } catch (error) {
      embeddedAgentLog.warn("context engine compaction maintenance failed", {
        sessionId: compactedSessionId,
        engineId: contextEngine.info.id,
        error: formatErrorMessage(error),
      });
    }
    await clearCodexAppServerBinding({
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    });
  }

  embeddedAgentLog.info("completed context-engine-owned Codex app-server compaction", {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    engineId: contextEngine.info.id,
    ok: result.ok,
    compacted: result.compacted,
    reason: result.reason,
    codexThreadBindingInvalidated: result.ok && result.compacted,
  });
  return {
    ok: result.ok,
    compacted: result.compacted,
    reason: result.reason,
    result: result.result
      ? {
          ...result.result,
          summary: result.result.summary ?? "",
          firstKeptEntryId: result.result.firstKeptEntryId ?? "",
          details: mergeContextEngineCompactionDetails(result.result.details, {
            engine: contextEngine.info.id,
            codexThreadBindingInvalidated: result.ok && result.compacted,
          }),
        }
      : result.ok && result.compacted
        ? {
            summary: "",
            firstKeptEntryId: "",
            tokensBefore: params.currentTokenCount ?? 0,
            details: { engine: contextEngine.info.id, codexThreadBindingInvalidated: true },
          }
        : undefined,
  };
}

function mergeContextEngineCompactionDetails(
  details: unknown,
  extra: Record<string, unknown>,
): unknown {
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return {
      ...(details as Record<string, unknown>),
      ...extra,
    };
  }
  return extra;
}

function buildContextEngineTranscriptScope(
  params: Pick<CompactEmbeddedAgentSessionParams, "agentId" | "path" | "sessionId">,
): { agentId: string; path?: string; sessionId: string } {
  return {
    agentId: params.agentId ?? "main",
    ...(params.path ? { path: params.path } : {}),
    sessionId: params.sessionId,
  };
}

function warnIfIgnoringOpenClawCompactionOverrides(
  params: CompactEmbeddedAgentSessionParams,
): void {
  const ignoredConfig = readIgnoredCompactionOverridePaths(params);
  if (ignoredConfig.length === 0) {
    return;
  }
  const warningKey = ignoredConfig.join("\0");
  if (warnedIgnoredCompactionOverrides.has(warningKey)) {
    return;
  }
  warnedIgnoredCompactionOverrides.add(warningKey);
  embeddedAgentLog.warn(
    "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ignoredConfig,
    },
  );
}

function readIgnoredCompactionOverridePaths(params: CompactEmbeddedAgentSessionParams): string[] {
  const ignored = new Set<string>();
  for (const entry of readCompactionOverrideEntries(params)) {
    const localProvider =
      typeof entry.record.provider === "string" ? entry.record.provider.trim() : "";
    const inheritedProvider =
      !localProvider && typeof entry.inheritedRecord?.provider === "string"
        ? entry.inheritedRecord.provider.trim()
        : "";
    const providerPath = localProvider
      ? `${entry.path}.compaction.provider`
      : inheritedProvider && entry.inheritedPath
        ? `${entry.inheritedPath}.compaction.provider`
        : undefined;
    if (typeof entry.record.model === "string" && entry.record.model.trim()) {
      ignored.add(`${entry.path}.compaction.model`);
    }
    if (providerPath) {
      ignored.add(providerPath);
    }
  }
  return [...ignored];
}

function readCompactionOverrideEntries(params: CompactEmbeddedAgentSessionParams): Array<{
  path: string;
  record: Record<string, unknown>;
  inheritedRecord?: Record<string, unknown>;
  inheritedPath?: string;
}> {
  const entries: Array<{
    path: string;
    record: Record<string, unknown>;
    inheritedRecord?: Record<string, unknown>;
    inheritedPath?: string;
  }> = [];
  const defaultCompaction = readRecord(readRecord(params.config?.agents)?.defaults)?.compaction;
  const defaultRecord = readRecord(defaultCompaction);
  if (defaultRecord) {
    entries.push({ path: "agents.defaults", record: defaultRecord });
  }
  const agentId = readAgentIdFromSessionKey(params.sessionKey ?? params.sandboxSessionKey);
  if (!agentId) {
    return entries;
  }
  const agents = Array.isArray(params.config?.agents?.list) ? params.config.agents.list : [];
  const activeAgent = agents.find((agent) => {
    const id = typeof agent?.id === "string" ? agent.id.trim().toLowerCase() : "";
    return id === agentId;
  });
  const agentCompaction = readRecord(activeAgent)?.compaction;
  const agentRecord = readRecord(agentCompaction);
  if (agentRecord) {
    entries.push({
      path: `agents.list.${agentId}`,
      record: agentRecord,
      inheritedRecord: defaultRecord,
      inheritedPath: "agents.defaults",
    });
  }
  return entries;
}

function readAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const parts = sessionKey?.trim().toLowerCase().split(":").filter(Boolean) ?? [];
  if (parts.length < 3 || parts[0] !== "agent") {
    return undefined;
  }
  return parts[1]?.trim() || undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function compactCodexNativeThread(
  params: CompactEmbeddedAgentSessionParams,
  options: { pluginConfig?: unknown; clientFactory?: CodexAppServerClientFactory } = {},
): Promise<EmbeddedAgentCompactResult | undefined> {
  if (params.trigger !== "manual") {
    embeddedAgentLog.info("skipping codex app-server compaction for non-manual trigger", {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      trigger: params.trigger,
    });
    return {
      ok: true,
      compacted: false,
      reason: "codex app-server owns automatic compaction",
      result: {
        summary: "",
        firstKeptEntryId: "",
        tokensBefore: params.currentTokenCount ?? 0,
        details: {
          backend: "codex-app-server",
          skipped: true,
          reason: "non_manual_trigger",
          trigger: params.trigger ?? "unknown",
        },
      },
    };
  }
  const nativeExecutionBlock = resolveCodexNativeExecutionBlock({
    config: params.config,
    sessionKey: params.sandboxSessionKey ?? params.sessionKey,
    sessionId: params.sessionId,
    surface: "native compaction",
  });
  if (nativeExecutionBlock) {
    return { ok: false, compacted: false, reason: nativeExecutionBlock };
  }
  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
  const bindingIdentity: CodexAppServerBindingIdentity = {
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  };
  const binding = await readCodexAppServerBinding(bindingIdentity, { config: params.config });
  if (!binding?.threadId) {
    return failedCodexThreadBindingCompactionResult(params, {
      reason: "no codex app-server thread binding",
      recovery: "missing_thread_binding",
    });
  }
  const requestedAuthProfileId = params.authProfileId?.trim() || undefined;
  if (
    requestedAuthProfileId &&
    binding.authProfileId &&
    binding.authProfileId !== requestedAuthProfileId
  ) {
    return { ok: false, compacted: false, reason: "auth profile mismatch for session binding" };
  }

  const clientFactory = options.clientFactory ?? defaultCodexAppServerClientFactory;
  const client = await clientFactory(
    appServer.start,
    requestedAuthProfileId ?? binding.authProfileId,
    params.agentDir,
    params.config,
  );
  try {
    await client.request("thread/compact/start", {
      threadId: binding.threadId,
    });
    embeddedAgentLog.info("started codex app-server compaction", {
      sessionId: params.sessionId,
      threadId: binding.threadId,
    });
  } catch (error) {
    if (isCodexThreadNotFoundError(error)) {
      return failedCodexThreadBindingCompactionResult(params, {
        threadId: binding.threadId,
        reason: formatCompactionError(error),
        recovery: "stale_thread_binding",
      });
    }
    embeddedAgentLog.warn("codex app-server compaction failed", {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      threadId: binding.threadId,
      reason: formatCompactionError(error),
    });
    return {
      ok: false,
      compacted: false,
      reason: formatCompactionError(error),
    };
  }
  const resultDetails: JsonObject = {
    backend: "codex-app-server",
    threadId: binding.threadId,
    signal: "thread/compact/start",
    pending: true,
  };
  return {
    ok: true,
    compacted: false,
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: params.currentTokenCount ?? 0,
      details: resultDetails,
    },
  };
}

function failedCodexThreadBindingCompactionResult(
  params: CompactEmbeddedAgentSessionParams,
  recovery: {
    reason: string;
    recovery: "missing_thread_binding" | "stale_thread_binding";
    threadId?: string;
  },
): EmbeddedAgentCompactResult {
  embeddedAgentLog.warn("codex app-server compaction could not use thread binding", {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    threadId: recovery.threadId,
    reason: recovery.reason,
    recovery: recovery.recovery,
  });
  return {
    ok: false,
    compacted: false,
    reason: recovery.reason,
    failure: {
      reason: recovery.recovery,
      rawError: recovery.reason,
    },
  };
}

function isCodexThreadNotFoundError(error: unknown): boolean {
  return formatCompactionError(error).toLowerCase().includes("thread not found");
}

function formatCompactionError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
