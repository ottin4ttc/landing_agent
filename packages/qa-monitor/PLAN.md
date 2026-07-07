# QA 监控平台（qa-monitor）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `packages/qa-monitor` 建一个独立服务：定时拉 openclaw `sessions.usage` RPC 进 SQLite，配飞书 SSO + 白名单的管理员看板。

**Architecture:** 三层 deep-leaf —— Collector（用 `@openclaw/gateway-client` 连网关拉用量 → 映射成行 → 幂等 upsert）、Store（SQLite：`qa_sessions` 快照 + `qa_admin_sessions` 登录会话 + `aggregate()` 聚合）、Web（飞书 OAuth + 白名单 fail-closed + 服务端渲染看板）。openclaw 核心零改动。

**Tech Stack:** TypeScript(ESM)、node:http、**`node:sqlite` 内置 `DatabaseSync`**（node 24 自带，无需装/编译原生模块，实测支持命名参数 `@x`、`ON CONFLICT` upsert、`date(...,'+8 hours')`）、`@openclaw/gateway-client`（复用，自动完成 connect 握手）、vitest、oxlint/oxfmt。

## Global Constraints

- node ≥ 22.19；包管理器 pnpm@11；纯 ESM（package.json `"type":"module"`）。
- 包名 `@openclaw/qa-monitor`，**private**，不发布；所有源文件头部加注释 `// landingAgent-specific (not upstream openclaw)`。
- **不改 openclaw 核心 `src/`**；只新增 `packages/qa-monitor/`。
- 传输复用 `@openclaw/gateway-client` 的 `GatewayClient`（workspace 依赖）。调 `sessions.usage` 必须在连接的 `role:"operator"` + `scopes:["operator.read"]` 下。
- **DB 用 `node:sqlite` 内置**：`import { DatabaseSync } from "node:sqlite"`；类型标注一律用 node:sqlite 的 `DatabaseSync`（不要 better-sqlite3 的旧类型）。node:sqlite 运行会打 `ExperimentalWarning`，无害；命名参数键可裸写（`{k:v}` 配 SQL `@k`）。`.get()/.all()` 返回 null-prototype 对象，属性访问正常。无 `.pragma()` 方法，用 `db.exec("PRAGMA journal_mode = WAL")`。
- **响应结果在 `payload`**（不是 `result`）；协议版本固定 4；`sessions.usage` 前必须完成 connect 握手（GatewayClient 自动处理）。
- **时区铁律**：所有按天/窗口用北京日历日，SQL 用 `date(ts/1000,'unixepoch','+8 hours')`。
- **鉴权 fail-closed**：白名单为空 = 拒绝所有；不在名单 → 403；未登录 API→401、页面→302。
- 每个任务：先写失败测试 → 跑挂 → 最小实现 → 跑过 → commit。测试用 vitest：`pnpm --filter @openclaw/qa-monitor test`。
- 时间戳统一用 epoch **毫秒** 存储（SQLite INTEGER）。

---

### Task 1: Package 骨架 + config

**Files:**

- Create: `packages/qa-monitor/package.json`
- Create: `packages/qa-monitor/tsconfig.json`
- Create: `packages/qa-monitor/vitest.config.ts`
- Create: `packages/qa-monitor/src/config.ts`
- Test: `packages/qa-monitor/test/config.test.ts`

**Interfaces:**

- Produces: `export type QaConfig = { gatewayUrl: string; port: number; dbPath: string; pollIntervalMs: number; feishu: { appId: string; appSecret: string; redirectUrl: string }; adminAllowedUsers: string[]; devToken: string | null; cookieSecure: boolean; usageRangeDays: number }`
- Produces: `export function loadConfig(env: NodeJS.ProcessEnv): QaConfig`

- [ ] **Step 1: package.json**

```json
{
  "name": "@openclaw/qa-monitor",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node --experimental-strip-types src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@openclaw/gateway-client": "workspace:*"
  },
  "devDependencies": {
    "vitest": "4.1.9"
  }
}
```

（DB 用内置 `node:sqlite`，无第三方 DB 依赖。vitest 固定 `4.1.9` 对齐根版本；根无 catalog。）

- [ ] **Step 2: tsconfig.json + vitest.config.ts**

`tsconfig.json`（根无 `tsconfig.base.json`，extends 根 `tsconfig.json`）:

```json
{ "extends": "../../tsconfig.json", "include": ["src", "test"] }
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

- [ ] **Step 3: Write the failing test** — `test/config.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("parses env with defaults", () => {
    const cfg = loadConfig({
      QA_FEISHU_APP_ID: "a",
      QA_FEISHU_APP_SECRET: "s",
      QA_FEISHU_REDIRECT_URL: "http://x/cb",
    } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(19010);
    expect(cfg.gatewayUrl).toBe("ws://127.0.0.1:19001");
    expect(cfg.adminAllowedUsers).toEqual([]);
    expect(cfg.cookieSecure).toBe(false);
    expect(cfg.feishu.appId).toBe("a");
  });
  it("parses allowed users csv and dev token", () => {
    const cfg = loadConfig({
      QA_FEISHU_APP_ID: "a",
      QA_FEISHU_APP_SECRET: "s",
      QA_FEISHU_REDIRECT_URL: "u",
      QA_ADMIN_ALLOWED_USERS: "ou_1, ou_2 ",
      QA_DEV_TOKEN: "dev",
      QA_COOKIE_SECURE: "true",
      QA_PORT: "20000",
    } as NodeJS.ProcessEnv);
    expect(cfg.adminAllowedUsers).toEqual(["ou_1", "ou_2"]);
    expect(cfg.devToken).toBe("dev");
    expect(cfg.cookieSecure).toBe(true);
    expect(cfg.port).toBe(20000);
  });
});
```

- [ ] **Step 4: Run test to verify it fails** — `pnpm --filter @openclaw/qa-monitor test` → FAIL (loadConfig not found)

- [ ] **Step 5: Implement** — `src/config.ts`

```ts
// landingAgent-specific (not upstream openclaw)
export type QaConfig = {
  gatewayUrl: string;
  port: number;
  dbPath: string;
  pollIntervalMs: number;
  feishu: { appId: string; appSecret: string; redirectUrl: string };
  adminAllowedUsers: string[];
  devToken: string | null;
  cookieSecure: boolean;
  usageRangeDays: number;
};

export function loadConfig(env: NodeJS.ProcessEnv): QaConfig {
  const csv = (v: string | undefined) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    gatewayUrl: env.QA_GATEWAY_URL ?? "ws://127.0.0.1:19001",
    port: Number(env.QA_PORT ?? 19010),
    dbPath: env.QA_DB_PATH ?? "./qa.db",
    pollIntervalMs: Number(env.QA_POLL_INTERVAL_MS ?? 180000),
    feishu: {
      appId: env.QA_FEISHU_APP_ID ?? "",
      appSecret: env.QA_FEISHU_APP_SECRET ?? "",
      redirectUrl: env.QA_FEISHU_REDIRECT_URL ?? "",
    },
    adminAllowedUsers: csv(env.QA_ADMIN_ALLOWED_USERS),
    devToken: env.QA_DEV_TOKEN ? env.QA_DEV_TOKEN : null,
    cookieSecure: env.QA_COOKIE_SECURE === "true",
    usageRangeDays: Number(env.QA_USAGE_RANGE_DAYS ?? 30),
  };
}
```

- [ ] **Step 6: Run test to verify it passes** — PASS
- [ ] **Step 7: Commit** — `git add packages/qa-monitor && git commit -m "feat(qa-monitor): package skeleton + config loader"`

---

### Task 2: SQLite schema + row types

**Files:**

- Create: `packages/qa-monitor/src/store/schema.ts`
- Create: `packages/qa-monitor/src/store/rows.ts`
- Test: `packages/qa-monitor/test/schema.test.ts`

**Interfaces:**

- Produces: `export type QaSessionRow` (字段见下)
- Produces: `export function openDb(path: string): DatabaseSync` （`node:sqlite` 实例，建表 + WAL）
- Consumes (later tasks): `qa_sessions`、`qa_admin_sessions` 两表

- [ ] **Step 1: Write the failing test** — `test/schema.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/schema.ts";

describe("openDb", () => {
  it("creates qa_sessions and qa_admin_sessions tables", () => {
    const db = openDb(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("qa_sessions");
    expect(tables).toContain("qa_admin_sessions");
    const cols = db
      .prepare("PRAGMA table_info(qa_sessions)")
      .all()
      .map((r: any) => r.name);
    expect(cols).toContain("session_key");
    expect(cols).toContain("total_tokens");
    expect(cols).toContain("user_id");
  });
});
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — `src/store/rows.ts`

```ts
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
```

`src/store/schema.ts`:

```ts
// landingAgent-specific (not upstream openclaw)
import { DatabaseSync } from "node:sqlite";

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS qa_sessions (
      session_key TEXT PRIMARY KEY,
      session_id TEXT, user_id TEXT, user_name TEXT,
      channel TEXT, chat_type TEXT, group_id TEXT,
      model TEXT, provider TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      user_msgs INTEGER NOT NULL DEFAULT 0,
      assistant_msgs INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      avg_latency_ms REAL, p95_latency_ms REAL,
      started_at INTEGER, last_interaction_at INTEGER, updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_qa_sessions_last ON qa_sessions(last_interaction_at);
    CREATE INDEX IF NOT EXISTS idx_qa_sessions_user ON qa_sessions(user_id);
    CREATE TABLE IF NOT EXISTS qa_admin_sessions (
      sid TEXT PRIMARY KEY, open_id TEXT NOT NULL, name TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
  `);
  return db;
}
```

- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `git commit -am "feat(qa-monitor): sqlite schema + row types"`

---

### Task 3: 幂等 upsert

**Files:**

- Create: `packages/qa-monitor/src/store/upsert.ts`
- Test: `packages/qa-monitor/test/upsert.test.ts`

**Interfaces:**

- Consumes: `openDb`, `QaSessionRow`, `QA_SESSION_COLUMNS`
- Produces: `export function upsertSessions(db: DatabaseSync, rows: QaSessionRow[]): number` （返回写入行数；同 session_key 覆盖，不双计）

- [ ] **Step 1: Write the failing test** — `test/upsert.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/schema.ts";
import { upsertSessions } from "../src/store/upsert.ts";
import type { QaSessionRow } from "../src/store/rows.ts";

const row = (over: Partial<QaSessionRow>): QaSessionRow => ({
  session_key: "k1",
  session_id: "s1",
  user_id: "ou_1",
  user_name: "张三",
  channel: "feishu",
  chat_type: "direct",
  group_id: null,
  model: "m",
  provider: "p",
  input_tokens: 10,
  output_tokens: 20,
  total_tokens: 30,
  cache_read: 0,
  cache_write: 0,
  cost_usd: 0.1,
  message_count: 4,
  user_msgs: 2,
  assistant_msgs: 2,
  tool_calls: 0,
  error_count: 0,
  avg_latency_ms: 100,
  p95_latency_ms: 150,
  started_at: 1000,
  last_interaction_at: 2000,
  updated_at: 2000,
  ...over,
});

describe("upsertSessions", () => {
  it("inserts then overwrites same session_key (idempotent, no double count)", () => {
    const db = openDb(":memory:");
    upsertSessions(db, [row({})]);
    upsertSessions(db, [row({ total_tokens: 55, message_count: 9 })]);
    const all = db.prepare("SELECT * FROM qa_sessions").all() as any[];
    expect(all).toHaveLength(1);
    expect(all[0].total_tokens).toBe(55);
    expect(all[0].message_count).toBe(9);
  });
});
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — `src/store/upsert.ts`

```ts
// landingAgent-specific (not upstream openclaw)
import type { DatabaseSync } from "node:sqlite";
import { QA_SESSION_COLUMNS, type QaSessionRow } from "./rows.ts";

export function upsertSessions(db: DatabaseSync, rows: QaSessionRow[]): number {
  if (rows.length === 0) return 0;
  const cols = QA_SESSION_COLUMNS;
  const placeholders = cols.map((c) => `@${c}`).join(", ");
  const updates = cols
    .filter((c) => c !== "session_key")
    .map((c) => `${c}=excluded.${c}`)
    .join(", ");
  const stmt = db.prepare(
    `INSERT INTO qa_sessions (${cols.join(", ")}) VALUES (${placeholders}) ` +
      `ON CONFLICT(session_key) DO UPDATE SET ${updates}`,
  );
  const tx = db.transaction((rs: QaSessionRow[]) => {
    for (const r of rs) stmt.run(r);
  });
  tx(rows);
  return rows.length;
}
```

- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `git commit -am "feat(qa-monitor): idempotent session upsert"`

---

### Task 4: usage 结果 → 行映射

**Files:**

- Create: `packages/qa-monitor/src/collector/map.ts`
- Test: `packages/qa-monitor/test/map.test.ts`

**Interfaces:**

- Consumes: `SessionsUsageResult`/`SessionUsageEntry`（`import type` 自 openclaw：`@openclaw/gateway-client` 若未 re-export，则从相对路径 `../../../../src/shared/usage-types.ts` import type，仅类型不产生运行时耦合）
- Produces: `export function mapUsageResultToRows(result: SessionsUsageResult): QaSessionRow[]`

字段映射（依据 `src/shared/usage-types.ts` + `src/infra/session-cost-usage.types.ts`）：`usage` 是 `SessionCostSummary | null`，token 用 `usage.input/output/totalTokens/cacheRead/cacheWrite`、成本用 `usage.totalCost`、消息用 `usage.messageCounts.{total,user,assistant,toolCalls,errors}`、延迟用 `usage.latency.{avgMs,p95Ms}`、时间用 `usage.firstActivity/lastActivity`。

- [ ] **Step 1: Write the failing test** — `test/map.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { mapUsageResultToRows } from "../src/collector/map.ts";

const result: any = {
  updatedAt: 5000,
  startDate: "2026-07-01",
  endDate: "2026-07-06",
  sessions: [
    {
      key: "k1",
      sessionId: "s1",
      agentId: "main",
      channel: "feishu",
      chatType: "direct",
      origin: { from: "ou_1", label: "张三", surface: "feishu", chatType: "direct" },
      model: "claude-opus-4.7",
      modelProvider: "zenmux",
      usage: {
        input: 10,
        output: 20,
        totalTokens: 30,
        cacheRead: 1,
        cacheWrite: 2,
        totalCost: 0.5,
        firstActivity: 1000,
        lastActivity: 2000,
        messageCounts: { total: 4, user: 2, assistant: 2, toolCalls: 0, toolResults: 0, errors: 0 },
        latency: { count: 2, avgMs: 100, p95Ms: 150, minMs: 50, maxMs: 200 },
      },
      updatedAt: 2000,
    },
    { key: "k2", usage: null, updatedAt: 3000 },
  ],
  totals: {},
  aggregates: {},
};

describe("mapUsageResultToRows", () => {
  it("maps fields and zero-fills null usage", () => {
    const rows = mapUsageResultToRows(result);
    expect(rows).toHaveLength(2);
    const a = rows[0];
    expect(a.session_key).toBe("k1");
    expect(a.user_id).toBe("ou_1");
    expect(a.user_name).toBe("张三");
    expect(a.total_tokens).toBe(30);
    expect(a.cost_usd).toBe(0.5);
    expect(a.message_count).toBe(4);
    expect(a.avg_latency_ms).toBe(100);
    expect(a.p95_latency_ms).toBe(150);
    expect(a.started_at).toBe(1000);
    expect(a.last_interaction_at).toBe(2000);
    const b = rows[1];
    expect(b.session_key).toBe("k2");
    expect(b.total_tokens).toBe(0);
    expect(b.cost_usd).toBe(0);
    expect(b.last_interaction_at).toBe(3000);
  });
});
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — `src/collector/map.ts`

```ts
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
```

（实现时若 `src/shared/usage-types.ts` 相对路径因 worktree 层级不同，改成正确的相对路径或用 openclaw 根 `#`别名；仅 `import type`，不引入运行时依赖。）

- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `git commit -am "feat(qa-monitor): map sessions.usage result to rows"`

---

### Task 5: 聚合查询 aggregate()

**Files:**

- Create: `packages/qa-monitor/src/store/aggregate.ts`
- Test: `packages/qa-monitor/test/aggregate.test.ts`

**Interfaces:**

- Consumes: `openDb`, `upsertSessions`, `QaSessionRow`
- Produces:

```ts
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
export function aggregate(db: DatabaseSync, filters: QaFilters): DashboardData;
```

口径：活跃/DAU/WAU 用 `last_interaction_at`，北京日 `date(last_interaction_at/1000,'unixepoch','+8 hours')`；DAU=窗口末日 distinct user_id；WAU=末日北京零点往前 7 个日历日 distinct user_id。

- [ ] **Step 1: Write the failing test** — `test/aggregate.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/schema.ts";
import { upsertSessions } from "../src/store/upsert.ts";
import { aggregate } from "../src/store/aggregate.ts";
import type { QaSessionRow } from "../src/store/rows.ts";

// 2026-07-06 12:00 北京 = 2026-07-06 04:00 UTC = 1783310400000
const D6 = Date.UTC(2026, 6, 6, 4, 0, 0);
const D1 = Date.UTC(2026, 6, 1, 4, 0, 0);
const mk = (o: Partial<QaSessionRow>): QaSessionRow => ({
  session_key: "k",
  session_id: null,
  user_id: "ou_1",
  user_name: "张三",
  channel: "feishu",
  chat_type: "direct",
  group_id: null,
  model: "m",
  provider: "p",
  input_tokens: 5,
  output_tokens: 5,
  total_tokens: 10,
  cache_read: 0,
  cache_write: 0,
  cost_usd: 0.2,
  message_count: 3,
  user_msgs: 1,
  assistant_msgs: 2,
  tool_calls: 0,
  error_count: 0,
  avg_latency_ms: 100,
  p95_latency_ms: 200,
  started_at: D6,
  last_interaction_at: D6,
  updated_at: D6,
  ...o,
});

describe("aggregate", () => {
  it("computes totals, active users, DAU/WAU, topUsers, byChatType", () => {
    const db = openDb(":memory:");
    upsertSessions(db, [
      mk({
        session_key: "a",
        user_id: "ou_1",
        last_interaction_at: D6,
        total_tokens: 10,
        message_count: 3,
      }),
      mk({
        session_key: "b",
        user_id: "ou_2",
        last_interaction_at: D6,
        total_tokens: 20,
        message_count: 5,
        chat_type: "group",
      }),
      mk({
        session_key: "c",
        user_id: "ou_1",
        last_interaction_at: D1,
        total_tokens: 7,
        message_count: 2,
      }),
    ]);
    const d = aggregate(db, { from: D1 - 1, to: D6 + 1 });
    expect(d.totalSessions).toBe(3);
    expect(d.totalMessages).toBe(10);
    expect(d.totalTokens).toBe(37);
    expect(d.activeUsers).toBe(2); // ou_1, ou_2 in window
    expect(d.dau).toBe(2); // last day 07-06: ou_1, ou_2
    expect(d.wau).toBe(2); // within 7 days
    expect(d.topUsers[0].user_id).toBe("ou_1"); // 2 sessions
    expect(d.byChatType.find((x) => x.chat_type === "group")!.sessions).toBe(1);
    expect(d.daily.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — `src/store/aggregate.ts`

```ts
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

function whereClause(f: QaFilters): { sql: string; params: Record<string, unknown> } {
  const conds: string[] = ["last_interaction_at IS NOT NULL"];
  const params: Record<string, unknown> = {};
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
```

- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `git commit -am "feat(qa-monitor): aggregate() dashboard metrics"`

---

### Task 6: Collector 传输 + 一次采集

**Files:**

- Create: `packages/qa-monitor/src/collector/source.ts`
- Create: `packages/qa-monitor/src/collector/index.ts`
- Test: `packages/qa-monitor/test/collect-once.test.ts`

**Interfaces:**

- Consumes: `GatewayClient`（`@openclaw/gateway-client`）, `mapUsageResultToRows`, `upsertSessions`, `QaConfig`
- Produces: `export type UsageFetcher = (cfg: QaConfig) => Promise<SessionsUsageResult>`
- Produces: `export function fetchUsageViaGateway(cfg: QaConfig): Promise<SessionsUsageResult>`
- Produces: `export async function collectOnce(db: DatabaseSync, cfg: QaConfig, fetch?: UsageFetcher): Promise<number>`
- Produces: `export function startCollector(db: DatabaseSync, cfg: QaConfig): () => void` （定时器，返回 stop）

采集逻辑用**可注入的 fetcher**，测试注入假 fetcher（不连真网关），真实现走 `GatewayClient`。

- [ ] **Step 1: Write the failing test** — `test/collect-once.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/schema.ts";
import { collectOnce } from "../src/collector/index.ts";

const fakeResult: any = {
  updatedAt: 1,
  startDate: "2026-07-01",
  endDate: "2026-07-06",
  sessions: [
    {
      key: "k1",
      origin: { from: "ou_1", label: "张三" },
      chatType: "direct",
      usage: {
        input: 1,
        output: 2,
        totalTokens: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalCost: 0.1,
        messageCounts: { total: 2, user: 1, assistant: 1, toolCalls: 0, toolResults: 0, errors: 0 },
        latency: { count: 1, avgMs: 10, p95Ms: 10, minMs: 10, maxMs: 10 },
        lastActivity: 2000,
      },
      updatedAt: 2000,
    },
  ],
  totals: {},
  aggregates: {},
};

describe("collectOnce", () => {
  it("fetches, maps and upserts; idempotent across two runs", async () => {
    const db = openDb(":memory:");
    const cfg: any = { usageRangeDays: 30 };
    const n1 = await collectOnce(db, cfg, async () => fakeResult);
    const n2 = await collectOnce(db, cfg, async () => fakeResult);
    expect(n1).toBe(1);
    expect(n2).toBe(1);
    const rows = db.prepare("SELECT COUNT(*) c FROM qa_sessions").get() as any;
    expect(rows.c).toBe(1); // same session_key not double-counted
  });
});
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — `src/collector/source.ts`

```ts
// landingAgent-specific (not upstream openclaw)
import { GatewayClient } from "@openclaw/gateway-client";
import type { SessionsUsageResult } from "../../../../src/shared/usage-types.ts";
import type { QaConfig } from "../config.ts";

export function fetchUsageViaGateway(cfg: QaConfig): Promise<SessionsUsageResult> {
  return new Promise((resolve, reject) => {
    const client = new GatewayClient({
      url: cfg.gatewayUrl,
      clientName: "gateway-client",
      clientVersion: "1.0.0",
      mode: "backend",
      role: "operator",
      scopes: ["operator.read"],
      onHelloOk: async () => {
        try {
          const usage = (await client.request("sessions.usage", {
            agentScope: "all",
            range: `${cfg.usageRangeDays}d`,
            mode: "utc",
            limit: 1000,
          })) as SessionsUsageResult;
          resolve(usage);
        } catch (e) {
          reject(e);
        } finally {
          client.stop();
        }
      },
      onConnectError: (e: unknown) => {
        client.stop();
        reject(e);
      },
    });
    client.start();
  });
}
```

（实现时按 `packages/gateway-client/src/client.ts` 的 `GatewayClientOptions` 真实字段名微调构造参数——subagent 报告的字段为准；若 `range` 取值域不含 `Nd` 任意 N，用固定 `"30d"` 或改传 `startDate`/`endDate`。）

`src/collector/index.ts`:

```ts
// landingAgent-specific (not upstream openclaw)
import type { DatabaseSync } from "node:sqlite";
import type { SessionsUsageResult } from "../../../../src/shared/usage-types.ts";
import type { QaConfig } from "../config.ts";
import { mapUsageResultToRows } from "./map.ts";
import { upsertSessions } from "../store/upsert.ts";
import { fetchUsageViaGateway } from "./source.ts";

export type UsageFetcher = (cfg: QaConfig) => Promise<SessionsUsageResult>;

export async function collectOnce(
  db: DatabaseSync,
  cfg: QaConfig,
  fetch: UsageFetcher = fetchUsageViaGateway,
): Promise<number> {
  const result = await fetch(cfg);
  const rows = mapUsageResultToRows(result);
  return upsertSessions(db, rows);
}

export function startCollector(db: DatabaseSync, cfg: QaConfig): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await collectOnce(db, cfg);
    } catch (e) {
      console.error("[qa-monitor] collect failed:", e);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), cfg.pollIntervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
```

- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: 手动冒烟**（真网关，非自动测试）：dev 网关开着时跑一个临时脚本调 `fetchUsageViaGateway`，确认能连上拿到数据、字段映射正确。若 `GatewayClient` 构造字段名与骨架不符，以真实 `packages/gateway-client` 导出为准修正。
- [ ] **Step 6: Commit** — `git commit -am "feat(qa-monitor): collector transport + collectOnce + scheduler"`

---

### Task 7: 白名单 + session 存储（安全核心）

**Files:**

- Create: `packages/qa-monitor/src/web/session-store.ts`
- Create: `packages/qa-monitor/src/web/whitelist.ts`
- Test: `packages/qa-monitor/test/auth-core.test.ts`

**Interfaces:**

- Produces: `export function isAllowed(allowed: string[], openId: string | null | undefined): boolean` （fail-closed：空名单/空 openId → false）
- Produces: `export function createSession(db, openId: string, name: string | null, now: number, ttlMs: number): string` （返回 sid）
- Produces: `export function getSession(db, sid: string | undefined, now: number): { open_id: string; name: string | null } | null`

- [ ] **Step 1: Write the failing test** — `test/auth-core.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/schema.ts";
import { isAllowed } from "../src/web/whitelist.ts";
import { createSession, getSession } from "../src/web/session-store.ts";

describe("isAllowed (fail-closed)", () => {
  it("empty whitelist rejects everyone", () => {
    expect(isAllowed([], "ou_1")).toBe(false);
  });
  it("rejects non-listed and empty openId, allows listed", () => {
    expect(isAllowed(["ou_1"], "ou_2")).toBe(false);
    expect(isAllowed(["ou_1"], null)).toBe(false);
    expect(isAllowed(["ou_1"], "")).toBe(false);
    expect(isAllowed(["ou_1"], "ou_1")).toBe(true);
  });
});

describe("session store", () => {
  it("creates and retrieves; expired returns null", () => {
    const db = openDb(":memory:");
    const sid = createSession(db, "ou_1", "张三", 1000, 100);
    expect(getSession(db, sid, 1050)).toEqual({ open_id: "ou_1", name: "张三" });
    expect(getSession(db, sid, 2000)).toBeNull(); // expired
    expect(getSession(db, "nope", 1050)).toBeNull();
    expect(getSession(db, undefined, 1050)).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement**

`src/web/whitelist.ts`:

```ts
// landingAgent-specific (not upstream openclaw)
export function isAllowed(allowed: string[], openId: string | null | undefined): boolean {
  if (!openId) return false;
  if (allowed.length === 0) return false; // fail-closed
  return allowed.includes(openId);
}
```

`src/web/session-store.ts`:

```ts
// landingAgent-specific (not upstream openclaw)
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function createSession(
  db: DatabaseSync,
  openId: string,
  name: string | null,
  now: number,
  ttlMs: number,
): string {
  const sid = randomBytes(24).toString("hex");
  db.prepare(
    "INSERT INTO qa_admin_sessions (sid, open_id, name, created_at, expires_at) VALUES (?,?,?,?,?)",
  ).run(sid, openId, name, now, now + ttlMs);
  return sid;
}

export function getSession(
  db: DatabaseSync,
  sid: string | undefined,
  now: number,
): { open_id: string; name: string | null } | null {
  if (!sid) return null;
  const row = db
    .prepare("SELECT open_id, name, expires_at FROM qa_admin_sessions WHERE sid=?")
    .get(sid) as any;
  if (!row || row.expires_at <= now) return null;
  return { open_id: row.open_id, name: row.name ?? null };
}
```

- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `git commit -am "feat(qa-monitor): fail-closed whitelist + sqlite session store"`

---

### Task 8: 飞书 OAuth 握手

**Files:**

- Create: `packages/qa-monitor/src/web/feishu-oauth.ts`
- Test: `packages/qa-monitor/test/feishu-oauth.test.ts`

**Interfaces:**

- Produces: `export function buildAuthorizeUrl(cfg, state: string): string`
- Produces: `export async function exchangeCodeForOpenId(cfg, code: string, http?: typeof fetch): Promise<{ openId: string; name: string | null }>`

依据飞书文档，端点：授权 `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=&redirect_uri=&state=`；app_access_token `POST /open-apis/auth/v3/app_access_token/internal`；换用户 `POST /open-apis/authen/v1/oidc/access_token`（body `{grant_type:"authorization_code", code}`，header `Authorization: Bearer <app_access_token>`）返回含 `open_id`、`name`。**以 `/Users/yb/dataclaw/dataclaw-service/src/routes/admin.js` 的 `buildAuthorizeUrl` / `handleCallback` 实测实现为准照抄端点与字段**（用户指定 dataclaw 为参考）。

- [ ] **Step 1: Write the failing test（只测 URL 构造 + 用注入 http 桩测 exchange 解析）** — `test/feishu-oauth.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { buildAuthorizeUrl, exchangeCodeForOpenId } from "../src/web/feishu-oauth.ts";

const cfg: any = {
  feishu: {
    appId: "cli_x",
    appSecret: "sec",
    redirectUrl: "http://localhost:19010/qa-admin/auth/callback",
  },
};

describe("buildAuthorizeUrl", () => {
  it("includes app_id, redirect_uri, state", () => {
    const u = buildAuthorizeUrl(cfg, "st1");
    expect(u).toContain("app_id=cli_x");
    expect(u).toContain(encodeURIComponent("http://localhost:19010/qa-admin/auth/callback"));
    expect(u).toContain("state=st1");
  });
});

describe("exchangeCodeForOpenId", () => {
  it("parses open_id and name from token responses", async () => {
    const http = (async (url: string) => {
      if (String(url).includes("app_access_token"))
        return { json: async () => ({ app_access_token: "aat" }) } as any;
      return { json: async () => ({ data: { open_id: "ou_1", name: "张三" } }) } as any;
    }) as unknown as typeof fetch;
    const r = await exchangeCodeForOpenId(cfg, "code123", http);
    expect(r).toEqual({ openId: "ou_1", name: "张三" });
  });
});
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — `src/web/feishu-oauth.ts`

```ts
// landingAgent-specific (not upstream openclaw)
import type { QaConfig } from "../config.ts";

const AUTH = "https://open.feishu.cn/open-apis/authen/v1/authorize";
const APP_TOKEN = "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal";
const USER_TOKEN = "https://open.feishu.cn/open-apis/authen/v1/oidc/access_token";

export function buildAuthorizeUrl(cfg: QaConfig, state: string): string {
  const p = new URLSearchParams({
    app_id: cfg.feishu.appId,
    redirect_uri: cfg.feishu.redirectUrl,
    state,
  });
  return `${AUTH}?${p.toString()}`;
}

export async function exchangeCodeForOpenId(
  cfg: QaConfig,
  code: string,
  http: typeof fetch = fetch,
): Promise<{ openId: string; name: string | null }> {
  const appRes = await http(APP_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: cfg.feishu.appId, app_secret: cfg.feishu.appSecret }),
  });
  const appJson = (await appRes.json()) as any;
  const appToken = appJson.app_access_token as string;
  const userRes = await http(USER_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${appToken}` },
    body: JSON.stringify({ grant_type: "authorization_code", code }),
  });
  const userJson = (await userRes.json()) as any;
  const data = userJson.data ?? userJson;
  return { openId: data.open_id as string, name: (data.name as string) ?? null };
}
```

- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: 冒烟**：实现后用真回调走一次飞书登录，核对端点/字段与线上一致（与 dataclaw admin.js 比对）。若字段名不同（如 v1 vs oidc），以 dataclaw 实测为准修正。
- [ ] **Step 6: Commit** — `git commit -am "feat(qa-monitor): feishu OAuth code exchange"`

---

### Task 9: HTTP 路由 + requireAuth + 登录流

**Files:**

- Create: `packages/qa-monitor/src/web/cookies.ts`
- Create: `packages/qa-monitor/src/web/server.ts`
- Test: `packages/qa-monitor/test/routes.test.ts`

**Interfaces:**

- Consumes: `aggregate`, `isAllowed`, `createSession`/`getSession`, `buildAuthorizeUrl`/`exchangeCodeForOpenId`, `renderDashboardHtml`(Task 10)
- Produces: `export function parseCookies(header: string | undefined): Record<string,string>`
- Produces: `export function createServer(db, cfg): http.Server`
- 路由：`GET /qa-admin/dashboard`（页面，需登录）、`GET /qa-admin/api/dashboard`（JSON，需登录）、`GET /qa-admin/login`→302 授权页、`GET /qa-admin/auth/callback`→换 openId+白名单+建 session+种 cookie、`GET /qa-admin/logout`。未登录：API→401、页面→302 `/qa-admin/login`。dev 后门：`?dev=<QA_DEV_TOKEN>` 命中则直建 session（仅当 `cfg.devToken` 非空）。

- [ ] **Step 1: Write the failing test（用 node:http 起服务打真实请求）** — `test/routes.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import { openDb } from "../src/store/schema.ts";
import { createServer } from "../src/web/server.ts";
import { parseCookies } from "../src/web/cookies.ts";

let server: Server;
afterEach(() => server?.close());
const base = (cfg: any) => {
  const db = openDb(":memory:");
  server = createServer(db, cfg);
  return new Promise<string>((res) =>
    server.listen(0, () => res(`http://127.0.0.1:${(server.address() as any).port}`)),
  );
};

describe("parseCookies", () => {
  it("parses cookie header", () => {
    expect(parseCookies("dcadmin_sid=abc; x=1")).toEqual({ dcadmin_sid: "abc", x: "1" });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe("routes auth gating", () => {
  const cfg = {
    port: 0,
    feishu: { appId: "a", appSecret: "s", redirectUrl: "u" },
    adminAllowedUsers: ["ou_1"],
    devToken: "dev",
    cookieSecure: false,
  };
  it("api without session -> 401", async () => {
    const url = await base(cfg);
    const r = await fetch(`${url}/qa-admin/api/dashboard`);
    expect(r.status).toBe(401);
  });
  it("page without session -> 302 to login", async () => {
    const url = await base(cfg);
    const r = await fetch(`${url}/qa-admin/dashboard`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/qa-admin/login");
  });
  it("dev backdoor logs in and api returns 200 json", async () => {
    const url = await base(cfg);
    const login = await fetch(`${url}/qa-admin/login?dev=dev`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const r = await fetch(`${url}/qa-admin/api/dashboard`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toHaveProperty("totalSessions");
  });
  it("dev backdoor rejected when devToken wrong", async () => {
    const url = await base(cfg);
    const login = await fetch(`${url}/qa-admin/login?dev=wrong`, { redirect: "manual" });
    expect(login.headers.get("set-cookie")).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — `src/web/cookies.ts`

```ts
// landingAgent-specific (not upstream openclaw)
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
```

`src/web/server.ts`（核心逻辑；`renderDashboardHtml` 见 Task 10）:

```ts
// landingAgent-specific (not upstream openclaw)
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { QaConfig } from "../config.ts";
import { aggregate, type QaFilters } from "../store/aggregate.ts";
import { isAllowed } from "./whitelist.ts";
import { createSession, getSession } from "./session-store.ts";
import { buildAuthorizeUrl, exchangeCodeForOpenId } from "./feishu-oauth.ts";
import { parseCookies } from "./cookies.ts";
import { renderDashboardHtml } from "./dashboard-html.ts";

const COOKIE = "dcadmin_sid";
const TTL = 24 * 60 * 60 * 1000;

function setCookie(cfg: QaConfig, sid: string): string {
  const parts = [
    `${COOKIE}=${sid}`,
    "Path=/qa-admin",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${TTL / 1000}`,
  ];
  if (cfg.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}
function filtersFromUrl(u: URL): QaFilters {
  const num = (k: string) => (u.searchParams.get(k) ? Number(u.searchParams.get(k)) : undefined);
  return {
    from: num("from"),
    to: num("to"),
    user: u.searchParams.get("user") ?? undefined,
    chatType: u.searchParams.get("chatType") ?? undefined,
    channel: u.searchParams.get("channel") ?? undefined,
  };
}

export function createServer(db: DatabaseSync, cfg: QaConfig): http.Server {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    const now = Date.now();
    const cookies = parseCookies(req.headers.cookie);
    const session = getSession(db, cookies[COOKIE], now);

    // login
    if (u.pathname === "/qa-admin/login") {
      if (cfg.devToken && u.searchParams.get("dev") === cfg.devToken) {
        const sid = createSession(db, "dev-admin", "Dev Admin", now, TTL);
        res.writeHead(302, { "set-cookie": setCookie(cfg, sid), location: "/qa-admin/dashboard" });
        return res.end();
      }
      res.writeHead(302, { location: buildAuthorizeUrl(cfg, randomBytes(8).toString("hex")) });
      return res.end();
    }
    // oauth callback
    if (u.pathname === "/qa-admin/auth/callback") {
      const code = u.searchParams.get("code");
      if (!code) {
        res.writeHead(400);
        return res.end("missing code");
      }
      try {
        const { openId, name } = await exchangeCodeForOpenId(cfg, code);
        if (!isAllowed(cfg.adminAllowedUsers, openId)) {
          res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
          return res.end("<h1>403 无权限</h1>");
        }
        const sid = createSession(db, openId, name, now, TTL);
        res.writeHead(302, { "set-cookie": setCookie(cfg, sid), location: "/qa-admin/dashboard" });
        return res.end();
      } catch {
        res.writeHead(500);
        return res.end("login failed");
      }
    }
    if (u.pathname === "/qa-admin/logout") {
      res.writeHead(302, {
        "set-cookie": `${COOKIE}=; Path=/qa-admin; Max-Age=0`,
        location: "/qa-admin/login",
      });
      return res.end();
    }
    // API (needs auth)
    if (u.pathname === "/qa-admin/api/dashboard") {
      if (!session) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      }
      const data = aggregate(db, filtersFromUrl(u));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(data));
    }
    // Dashboard page (needs auth)
    if (u.pathname === "/qa-admin/dashboard") {
      if (!session) {
        res.writeHead(302, { location: "/qa-admin/login" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(renderDashboardHtml(session));
    }
    res.writeHead(404);
    res.end("not found");
  });
}
```

- [ ] **Step 4: Run → PASS**（Task 10 的 `renderDashboardHtml` 若未实现，先建一个最小 stub 让本任务测试通过，Task 10 再补全）
- [ ] **Step 5: Commit** — `git commit -am "feat(qa-monitor): http routes, auth gating, feishu login + dev backdoor"`

---

### Task 10: Dashboard 页面渲染

**Files:**

- Create: `packages/qa-monitor/src/web/dashboard-html.ts`
- Test: `packages/qa-monitor/test/dashboard-html.test.ts`

**Interfaces:**

- Consumes: 无（纯字符串渲染；数据由前端 JS 拉 `/qa-admin/api/dashboard`）
- Produces: `export function esc(s: unknown): string`
- Produces: `export function renderDashboardHtml(session: { open_id: string; name: string | null }): string`

页面：静态 HTML 外壳 + 顶栏（标题/登录人/登出）+ 筛选条 + KPI 卡片容器 `#cards` + 图表容器；内联 `<script>` 在 load 时 fetch API、render KPI 卡与 daily bar（div 宽度条形）与 topUsers 表。全部动态文本经 `esc()`。

- [ ] **Step 1: Write the failing test** — `test/dashboard-html.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { esc, renderDashboardHtml } from "../src/web/dashboard-html.ts";

describe("esc", () => {
  it("escapes html", () => {
    expect(esc('<b>&"x')).toBe("&lt;b&gt;&amp;&quot;x");
  });
});

describe("renderDashboardHtml", () => {
  it("includes title, logged-in name, cards container, api fetch", () => {
    const html = renderDashboardHtml({ open_id: "ou_1", name: "张三" });
    expect(html).toContain("landingAgent QA");
    expect(html).toContain("张三");
    expect(html).toContain('id="cards"');
    expect(html).toContain("/qa-admin/api/dashboard");
    expect(html).toContain("/qa-admin/logout");
  });
  it("escapes the session name", () => {
    const html = renderDashboardHtml({ open_id: "x", name: "<script>evil" });
    expect(html).not.toContain("<script>evil");
    expect(html).toContain("&lt;script&gt;evil");
  });
});
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — `src/web/dashboard-html.ts`（完整、可用；样式从简，对齐 dataclaw 朴素看板）

```ts
// landingAgent-specific (not upstream openclaw)
export function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderDashboardHtml(session: { open_id: string; name: string | null }): string {
  const who = esc(session.name ?? session.open_id);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>landingAgent QA 监控</title>
<style>
  body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f7fa;color:#1a2430}
  .top{background:linear-gradient(90deg,#0e7c86,#0a5960);color:#fff;padding:14px 20px;display:flex;align-items:center;gap:12px}
  .top b{font-size:16px}.top .sp{margin-left:auto;font-size:13px;opacity:.9}
  .top a{color:#fff;font-size:13px;margin-left:14px}
  .wrap{max-width:1100px;margin:0 auto;padding:20px}
  .filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
  .filters input,.filters select{padding:6px 8px;border:1px solid #cfd8de;border-radius:6px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
  .card{background:#fff;border:1px solid #e3e8ec;border-radius:10px;padding:14px 16px}
  .card .k{font-size:12px;color:#5a6b78}.card .v{font-size:24px;font-weight:700;margin-top:4px}
  h3{font-size:14px;margin:18px 0 8px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e8ec;border-radius:10px;overflow:hidden}
  th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #eef2f5;font-size:13px}
  th{background:#f0f4f6;color:#5a6b78}
  .bar{height:14px;background:#0e7c86;border-radius:3px}
</style></head><body>
<div class="top"><b>landingAgent QA 监控</b><span style="font-size:12px;opacity:.85">仅管理员</span>
  <span class="sp">登录：${who}<a href="/qa-admin/logout">登出</a></span></div>
<div class="wrap">
  <div class="filters">
    <input type="date" id="from"><input type="date" id="to">
    <input type="text" id="user" placeholder="用户 openId">
    <select id="chatType"><option value="">全部</option><option value="direct">私聊</option><option value="group">群聊</option></select>
    <button onclick="load()">查询</button>
  </div>
  <div class="cards" id="cards"></div>
  <h3>每日趋势</h3><div id="daily"></div>
  <h3>按人排行</h3><div id="topusers"></div>
  <h3>按会话类型</h3><div id="bychat"></div>
</div>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function card(k,v){return '<div class="card"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div></div>';}
async function load(){
  const q=new URLSearchParams();
  for(const id of ['from','to','user','chatType']){const el=document.getElementById(id);if(el&&el.value){
    if(id==='from')q.set('from',String(new Date(el.value+'T00:00:00+08:00').getTime()));
    else if(id==='to')q.set('to',String(new Date(el.value+'T23:59:59+08:00').getTime()));
    else q.set(id,el.value);}}
  const r=await fetch('/qa-admin/api/dashboard?'+q.toString());
  if(r.status===401){location.href='/qa-admin/login';return;}
  const d=await r.json();
  document.getElementById('cards').innerHTML=
    card('会话总数',d.totalSessions)+card('总消息数',d.totalMessages)+card('活跃用户',d.activeUsers)+
    card('DAU',d.dau)+card('WAU',d.wau)+card('Token 消耗',d.totalTokens)+
    card('成本(USD)',(d.totalCost||0).toFixed(3))+card('平均延迟(ms)',d.avgLatencyMs==null?'—':Math.round(d.avgLatencyMs))+
    card('P95 延迟(ms)',d.p95LatencyMs==null?'—':Math.round(d.p95LatencyMs));
  const maxT=Math.max(1,...d.daily.map(x=>x.tokens||0));
  document.getElementById('daily').innerHTML=d.daily.map(x=>
    '<div style="display:flex;align-items:center;gap:8px;margin:2px 0"><span style="width:90px;font-size:12px">'+esc(x.date)+
    '</span><div class="bar" style="width:'+Math.round(300*(x.tokens||0)/maxT)+'px"></div><span style="font-size:12px">'+esc(x.tokens)+'</span></div>').join('');
  document.getElementById('topusers').innerHTML='<table><tr><th>用户</th><th>会话</th><th>消息</th><th>Token</th><th>成本</th></tr>'+
    d.topUsers.map(u=>'<tr><td>'+esc(u.user_name||u.user_id)+'</td><td>'+esc(u.sessions)+'</td><td>'+esc(u.messages)+'</td><td>'+esc(u.tokens)+'</td><td>'+esc((u.cost||0).toFixed(3))+'</td></tr>').join('')+'</table>';
  document.getElementById('bychat').innerHTML='<table><tr><th>类型</th><th>会话</th><th>Token</th></tr>'+
    d.byChatType.map(c=>'<tr><td>'+esc(c.chat_type)+'</td><td>'+esc(c.sessions)+'</td><td>'+esc(c.tokens)+'</td></tr>').join('')+'</table>';
}
load();
</script></body></html>`;
}
```

- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `git commit -am "feat(qa-monitor): dashboard html render"`

---

### Task 11: 入口装配 + 端到端冒烟

**Files:**

- Create: `packages/qa-monitor/src/index.ts`
- Create: `packages/qa-monitor/README.md`
- Test:（手动端到端，非单测）

**Interfaces:**

- Consumes: `loadConfig`, `openDb`, `startCollector`, `createServer`

- [ ] **Step 1: Implement** — `src/index.ts`

```ts
// landingAgent-specific (not upstream openclaw)
import { loadConfig } from "./config.ts";
import { openDb } from "./store/schema.ts";
import { startCollector } from "./collector/index.ts";
import { createServer } from "./web/server.ts";

const cfg = loadConfig(process.env);
const db = openDb(cfg.dbPath);
const stop = startCollector(db, cfg);
const server = createServer(db, cfg);
server.listen(cfg.port, () =>
  console.log(`[qa-monitor] listening on http://127.0.0.1:${cfg.port}/qa-admin/dashboard`),
);
process.on("SIGINT", () => {
  stop();
  server.close();
  db.close();
  process.exit(0);
});
```

- [ ] **Step 2: README.md** — 写清 env 变量、启动命令、飞书重定向 URL 待办。

- [ ] **Step 3: 全量校验**
      Run:

```
pnpm --filter @openclaw/qa-monitor test
pnpm tsgo
pnpm lint
```

Expected: 全绿。

- [ ] **Step 4: 端到端冒烟**（dev 网关开着 + 有真实会话数据）：

```
QA_FEISHU_APP_ID=cli_aac1192ba3759cc0 QA_FEISHU_APP_SECRET=... \
QA_FEISHU_REDIRECT_URL=http://localhost:19010/qa-admin/auth/callback \
QA_ADMIN_ALLOWED_USERS=ou_2cd81c53ea8a2deb28cd2afd72421c8f \
QA_DEV_TOKEN=devsecret \
pnpm --filter @openclaw/qa-monitor start
```

浏览器开 `http://localhost:19010/qa-admin/login?dev=devsecret` → 应重定向到 dashboard，KPI/表格有数据（先在飞书里跟机器人多聊几句制造数据，等 Collector 拉一轮）。

- [ ] **Step 5: Commit** — `git commit -am "feat(qa-monitor): entrypoint wiring + README"`

---

## Self-Review（作者自查）

**Spec coverage**：

- 架构三组件 → Task 2/3/5(Store)、Task 4/6(Collector)、Task 7/8/9/10(Web) ✔
- 数据模型 qa_sessions → Task 2 ✔；指标口径(DAU/WAU 北京日/topUsers/byChatType) → Task 5 ✔
- 飞书 SSO + 白名单 fail-closed + session + requireAuth → Task 7/8/9 ✔；dev 后门 → Task 9 ✔
- dashboard 页面(KPI/筛选/趋势/排行) → Task 10 ✔
- package/测试/env → Task 1/11 ✔；不动 openclaw 核心 → 全部只在 packages/qa-monitor/ ✔
- 上云路径属"只设计不实现"，无对应实现任务（符合 spec 非目标）✔

**类型一致性**：`QaSessionRow`(Task2) 被 Task3/4/5 一致引用；`QaFilters`/`DashboardData`(Task5) 被 Task9 消费；`getSession` 返回 `{open_id,name}` 被 Task9 一致使用。

**已知实现期风险（非占位符，是需在实现时对真环境校准的点）**：

1. `@openclaw/gateway-client` 的 `GatewayClient` 构造参数名以 `packages/gateway-client/src/client.ts` 真实导出为准（Task6 Step5 冒烟校准）。
2. 飞书 OAuth 端点/字段以 dataclaw `admin.js` 实测为准（Task8 Step5 冒烟校准）。
3. `import type` 跨包引用 `src/shared/usage-types.ts` 的相对路径依 worktree 实际层级调整（只类型、无运行时耦合）。
4. `sessions.usage` 的 `range:"Nd"` 若不接受任意 N，退回固定 `"30d"` 或传 `startDate/endDate`。
