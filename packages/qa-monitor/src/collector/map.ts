// landingAgent-specific (not upstream openclaw)
import type { SessionsUsageResult, SessionUsageEntry } from "../../../../src/shared/usage-types.ts";
import type { QaSessionRow } from "../store/rows.ts";

function mapEntry(e: SessionUsageEntry): QaSessionRow {
  const u = e.usage;
  const mc = u?.messageCounts;
  const lat = u?.latency;
  const groupId = e.origin?.threadId != null ? String(e.origin.threadId) : null;
  return {
    session_key: e.key,
    session_id: e.sessionId ?? null,
    user_id: e.origin?.from ?? null,
    user_name: e.label ?? e.origin?.label ?? null,
    channel: e.channel ?? e.origin?.surface ?? null,
    chat_type: e.chatType ?? e.origin?.chatType ?? null,
    group_id: groupId,
    model: e.model ?? null,
    provider: e.modelProvider ?? null,
    input_tokens: u?.input ?? 0,
    output_tokens: u?.output ?? 0,
    total_tokens: u?.totalTokens ?? 0,
    cache_read: u?.cacheRead ?? 0,
    cache_write: u?.cacheWrite ?? 0,
    cost_usd: u?.totalCost ?? 0,
    message_count: mc?.total ?? 0,
    user_msgs: mc?.user ?? 0,
    assistant_msgs: mc?.assistant ?? 0,
    tool_calls: mc?.toolCalls ?? 0,
    error_count: mc?.errors ?? 0,
    avg_latency_ms: lat?.avgMs ?? null,
    p95_latency_ms: lat?.p95Ms ?? null,
    started_at: u?.firstActivity ?? null,
    last_interaction_at: u?.lastActivity ?? e.updatedAt ?? null,
    updated_at: e.updatedAt ?? null,
  };
}

export function mapUsageResultToRows(result: SessionsUsageResult): QaSessionRow[] {
  return result.sessions.map(mapEntry);
}
