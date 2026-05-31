import {
  deleteSqliteSessionTranscript,
  loadSqliteSessionTranscriptEvents,
  mergeSqliteSessionTranscriptEvents,
} from "../config/sessions/transcript-store.sqlite.js";

/** Resolve the synthetic SQLite session id used for a hidden internal run transcript. */
export function resolveInternalSessionEffectsTranscriptSessionId(runId: string): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "run";
  return `internal-agent-runs:${safeRunId}`;
}

/** Create a private SQLite transcript for internal session effects and copy source history into it. */
export async function prepareInternalSessionEffectsTranscript(params: {
  agentId: string;
  runId: string;
  sourceSessionId?: string;
}): Promise<{ agentId: string; sessionId: string }> {
  // Callers must persist this id in an owning lifecycle record and invoke
  // removeInternalSessionEffectsTranscript once the recovered output is no longer needed.
  const sessionId = resolveInternalSessionEffectsTranscriptSessionId(params.runId);
  deleteSqliteSessionTranscript({ agentId: params.agentId, sessionId });
  const events = params.sourceSessionId
    ? loadSqliteSessionTranscriptEvents({
        agentId: params.agentId,
        sessionId: params.sourceSessionId,
      }).map((entry) => entry.event)
    : [];
  mergeSqliteSessionTranscriptEvents({
    agentId: params.agentId,
    sessionId,
    events,
  });
  return { agentId: params.agentId, sessionId };
}

/** Delete a private SQLite transcript created for internal session effects. */
export async function removeInternalSessionEffectsTranscript(params: {
  agentId: string;
  sessionId: string | undefined;
}): Promise<void> {
  if (!params.sessionId?.startsWith("internal-agent-runs:")) {
    return;
  }
  deleteSqliteSessionTranscript({ agentId: params.agentId, sessionId: params.sessionId });
}
