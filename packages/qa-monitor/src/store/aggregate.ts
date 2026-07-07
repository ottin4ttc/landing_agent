// landingAgent-specific (not upstream openclaw)
import type { DatabaseSync } from "node:sqlite";

export type QaFilters = {
  from?: number;
  to?: number;
  user?: string;
  chatType?: string;
  channel?: string;
};
export type DashboardData = {
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalCost: number;
  activeUsers: number;
  dau: number;
  wau: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  topUsers: Array<{
    user_id: string;
    user_name: string | null;
    sessions: number;
    messages: number;
    tokens: number;
    cost: number;
  }>;
  byChatType: Array<{ chat_type: string; sessions: number; tokens: number }>;
  daily: Array<{ date: string; sessions: number; tokens: number }>;
};

type SqlParams = Record<string, string | number>;

function whereClause(f: QaFilters): { sql: string; params: SqlParams } {
  const conds: string[] = ["last_interaction_at IS NOT NULL"];
  const params: SqlParams = {};
  if (f.from != null) {
    conds.push("last_interaction_at >= @from");
    params.from = f.from;
  }
  if (f.to != null) {
    conds.push("last_interaction_at <= @to");
    params.to = f.to;
  }
  if (f.user) {
    conds.push("user_id = @user");
    params.user = f.user;
  }
  if (f.chatType) {
    conds.push("chat_type = @chatType");
    params.chatType = f.chatType;
  }
  if (f.channel) {
    conds.push("channel = @channel");
    params.channel = f.channel;
  }
  return { sql: conds.join(" AND "), params };
}
const BJ = "date(last_interaction_at/1000,'unixepoch','+8 hours')";

export function aggregate(db: DatabaseSync, filters: QaFilters): DashboardData {
  const { sql: where, params } = whereClause(filters);
  const totals = db
    .prepare(
      `SELECT COUNT(*) sessions, COALESCE(SUM(message_count),0) messages,
       COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(input_tokens),0) input,
       COALESCE(SUM(output_tokens),0) output, COALESCE(SUM(cache_read+cache_write),0) cache,
       COALESCE(SUM(cost_usd),0) cost,
       COUNT(DISTINCT user_id) users,
       AVG(avg_latency_ms) avgLat, AVG(p95_latency_ms) p95Lat
     FROM qa_sessions WHERE ${where}`,
    )
    .get(params) as any;

  const lastDay = db
    .prepare(`SELECT MAX(${BJ}) d FROM qa_sessions WHERE ${where}`)
    .get(params) as any;
  const dayStr = lastDay?.d as string | null;
  const dau = dayStr
    ? (
        db
          .prepare(`SELECT COUNT(DISTINCT user_id) n FROM qa_sessions WHERE ${where} AND ${BJ}=@d`)
          .get({ ...params, d: dayStr }) as any
      ).n
    : 0;
  const wau = dayStr
    ? (
        db
          .prepare(
            `SELECT COUNT(DISTINCT user_id) n FROM qa_sessions WHERE ${where} AND ${BJ} > date(@d,'-7 days')`,
          )
          .get({ ...params, d: dayStr }) as any
      ).n
    : 0;

  const topUsers = db
    .prepare(
      `SELECT user_id, MAX(user_name) user_name, COUNT(*) sessions, SUM(message_count) messages,
       SUM(total_tokens) tokens, SUM(cost_usd) cost
     FROM qa_sessions WHERE ${where} AND user_id IS NOT NULL
     GROUP BY user_id ORDER BY sessions DESC, tokens DESC LIMIT 50`,
    )
    .all(params) as any[];

  const byChatType = db
    .prepare(
      `SELECT COALESCE(chat_type,'unknown') chat_type, COUNT(*) sessions, SUM(total_tokens) tokens
     FROM qa_sessions WHERE ${where} GROUP BY chat_type ORDER BY sessions DESC`,
    )
    .all(params) as any[];

  const daily = db
    .prepare(
      `SELECT ${BJ} date, COUNT(*) sessions, SUM(total_tokens) tokens
     FROM qa_sessions WHERE ${where} GROUP BY ${BJ} ORDER BY date ASC`,
    )
    .all(params) as any[];

  return {
    totalSessions: totals.sessions,
    totalMessages: totals.messages,
    totalTokens: totals.tokens,
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheTokens: totals.cache,
    totalCost: totals.cost,
    activeUsers: totals.users,
    dau,
    wau,
    avgLatencyMs: totals.avgLat ?? null,
    p95LatencyMs: totals.p95Lat ?? null,
    topUsers,
    byChatType,
    daily,
  };
}
