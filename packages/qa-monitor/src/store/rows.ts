// landingAgent-specific (not upstream openclaw)
export type QaSessionRow = {
  session_key: string;
  session_id: string | null;
  user_id: string | null;
  user_name: string | null;
  channel: string | null;
  chat_type: string | null;
  group_id: string | null;
  model: string | null;
  provider: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  message_count: number;
  user_msgs: number;
  assistant_msgs: number;
  tool_calls: number;
  error_count: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  started_at: number | null;
  last_interaction_at: number | null;
  updated_at: number | null;
};

export const QA_SESSION_COLUMNS: (keyof QaSessionRow)[] = [
  "session_key",
  "session_id",
  "user_id",
  "user_name",
  "channel",
  "chat_type",
  "group_id",
  "model",
  "provider",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cache_read",
  "cache_write",
  "cost_usd",
  "message_count",
  "user_msgs",
  "assistant_msgs",
  "tool_calls",
  "error_count",
  "avg_latency_ms",
  "p95_latency_ms",
  "started_at",
  "last_interaction_at",
  "updated_at",
];
