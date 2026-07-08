// landingAgent-specific (not upstream openclaw)
// File-based collector: read the gateway's session files directly from a
// read-only mounted volume instead of the sessions.usage RPC. This sidesteps
// the operator-scope requirement that a plain gateway token cannot satisfy for
// an external ws client. Same-host deployment: the gateway's ~/.openclaw is
// mounted read-only into qa-monitor.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QaSessionRow } from "../store/rows.ts";

type SessionOrigin = {
  from?: string;
  label?: string;
  surface?: string;
  chatType?: string;
  threadId?: string | number;
};
type SessionEntry = {
  sessionId?: string;
  chatType?: string;
  model?: string;
  modelProvider?: string;
  lastChannel?: string;
  startedAt?: number;
  lastInteractionAt?: number;
  updatedAt?: number;
  status?: string;
  origin?: SessionOrigin;
};

type TranscriptStats = {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  messages: number;
  userMsgs: number;
  assistantMsgs: number;
  toolCalls: number;
  errors: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
};

const EMPTY_STATS: TranscriptStats = {
  input: 0,
  output: 0,
  total: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  messages: 0,
  userMsgs: 0,
  assistantMsgs: 0,
  toolCalls: 0,
  errors: 0,
  avgLatencyMs: null,
  p95LatencyMs: null,
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Parse one session JSONL transcript, summing token usage and counting messages. */
export function parseTranscript(text: string): TranscriptStats {
  const s: TranscriptStats = { ...EMPTY_STATS };
  const latencies: number[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = rec.message as Record<string, unknown> | undefined;
    if (!msg || typeof msg.role !== "string") continue;
    s.messages += 1;
    if (msg.role === "user") s.userMsgs += 1;
    else if (msg.role === "assistant") s.assistantMsgs += 1;
    else if (msg.role === "tool") s.toolCalls += 1;
    if (msg.error) s.errors += 1;
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (usage) {
      s.input += num(usage.input);
      s.output += num(usage.output);
      s.cacheRead += num(usage.cacheRead);
      s.cacheWrite += num(usage.cacheWrite);
      s.total += num(usage.totalTokens);
      const cost = usage.cost as Record<string, unknown> | undefined;
      if (cost) s.cost += num(cost.total);
    }
    const dur = num(msg.durationMs);
    if (dur > 0) latencies.push(dur);
  }
  if (latencies.length > 0) {
    s.avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    s.p95LatencyMs = percentile(
      [...latencies].sort((a, b) => a - b),
      95,
    );
  }
  return s;
}

function toRow(key: string, e: SessionEntry, stats: TranscriptStats): QaSessionRow {
  const groupId = e.origin?.threadId != null ? String(e.origin.threadId) : null;
  return {
    session_key: key,
    session_id: e.sessionId ?? null,
    user_id: e.origin?.from ?? null,
    user_name: e.origin?.label ?? null,
    channel: e.lastChannel ?? e.origin?.surface ?? null,
    chat_type: e.chatType ?? e.origin?.chatType ?? null,
    group_id: groupId,
    model: e.model ?? null,
    provider: e.modelProvider ?? null,
    input_tokens: stats.input,
    output_tokens: stats.output,
    total_tokens: stats.total,
    cache_read: stats.cacheRead,
    cache_write: stats.cacheWrite,
    cost_usd: stats.cost,
    message_count: stats.messages,
    user_msgs: stats.userMsgs,
    assistant_msgs: stats.assistantMsgs,
    tool_calls: stats.toolCalls,
    error_count: stats.errors,
    avg_latency_ms: stats.avgLatencyMs,
    p95_latency_ms: stats.p95LatencyMs,
    started_at: e.startedAt ?? null,
    last_interaction_at: e.lastInteractionAt ?? e.updatedAt ?? null,
    updated_at: e.updatedAt ?? null,
  };
}

/**
 * Read all agents' session indices under `agentsDir` (e.g. ~/.openclaw/agents),
 * parse each session's transcript, and return one QaSessionRow per session.
 */
export function readSessionsFromDir(agentsDir: string): QaSessionRow[] {
  const rows: QaSessionRow[] = [];
  if (!existsSync(agentsDir)) return rows;
  for (const agent of readdirSync(agentsDir)) {
    const sessDir = join(agentsDir, agent, "sessions");
    const indexPath = join(sessDir, "sessions.json");
    if (!existsSync(indexPath)) continue;
    let sessions: Record<string, SessionEntry>;
    try {
      sessions = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, SessionEntry>;
    } catch {
      continue;
    }
    for (const [key, entry] of Object.entries(sessions)) {
      let stats = EMPTY_STATS;
      if (entry.sessionId) {
        const jsonl = join(sessDir, `${entry.sessionId}.jsonl`);
        if (existsSync(jsonl)) {
          try {
            stats = parseTranscript(readFileSync(jsonl, "utf8"));
          } catch {
            stats = EMPTY_STATS;
          }
        }
      }
      rows.push(toRow(key, entry, stats));
    }
  }
  return rows;
}
