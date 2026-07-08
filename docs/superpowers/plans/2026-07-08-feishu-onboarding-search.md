# 飞书 Onboarding 知识检索改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 landingAgent 飞书机器人用「专用服务账号的 user_access_token」搜索并读取公司企业公开 wiki 知识库，从而能用真实制度内容回答新人问题。

**Architecture:** 在 `extensions/feishu/` 内新增一个 user_access_token 生命周期模块（内存缓存 access_token + 落盘滚动 refresh_token），把现有 `feishu_search` 的搜索路径从 tenant-token 的 `docWiki.search` 换成 user-token 的 `wiki/v1/nodes/search`，并新增一个按 obj_type 分派的文档读取器。全部 raw HTTP，注入 fetch/时钟便于测试。

**Tech Stack:** TypeScript ESM、Node ≥22.19、vitest、typebox、飞书 OpenAPI（`https://open.feishu.cn`）。

## Global Constraints

- 代码集中在 `extensions/feishu/`，不动 openclaw 核心 `src/`。
- 密钥（seed refresh_token、appSecret）只进环境变量，经 secretRef `{source:"env"}` 引用，不写 config 明文。
- Node ≥ 22.19；TypeScript ESM（相对 import 带 `.js` 后缀）；vitest；oxlint/oxfmt；**禁止 `--no-verify`**。
- 飞书 API base：`https://open.feishu.cn`。appId：`cli_aac1192ba3759cc0`。
- 飞书 refresh_token 30 天有效、每刷返新；access_token `expires_in` 单位秒（~2h）。
- 提交粒度：整个需求最后一次性 commit 到 `feat/feishu-search`；但本计划按 task 逐步 commit（executing 时每 task 一 commit，符合 sdd 复核节奏）。

## File Structure

- `extensions/feishu/src/user-token.ts`（新）：`FeishuUserTokenProvider` + `RefreshTokenStore` 接口 + `createFeishuUserTokenProvider` + `FeishuUserTokenError`。纯逻辑，注入 fetch/now/store。
- `extensions/feishu/src/user-token.test.ts`（新）
- `extensions/feishu/src/file-refresh-store.ts`（新）：`createFileRefreshTokenStore(path)` 实现 `RefreshTokenStore`，原子写 + 0600。
- `extensions/feishu/src/file-refresh-store.test.ts`（新）
- `extensions/feishu/src/search.ts`（改）：新增 `searchWikiNodes`，`FeishuSearchResultItem` 加 `objToken?`/`objType?`，`registerFeishuSearchTools` 接线。
- `extensions/feishu/src/onboarding-doc-read.ts`（新）：`readWikiDocContent` 按 obj_type 分派。
- `extensions/feishu/src/onboarding-doc-read.test.ts`（新）
- `extensions/feishu/src/config-schema.ts`（改）：账号级 `onboardingSearch` 配置。
- `scripts/feishu-exchange-refresh.mjs`（新）：一次性 code → refresh_token。
- `docs/feishu-service-account-bootstrap.md`（新）：runbook。

---

### Task 1: FeishuUserTokenProvider（token 生命周期核心）

**Files:**
- Create: `extensions/feishu/src/user-token.ts`
- Test: `extensions/feishu/src/user-token.test.ts`

**Interfaces:**
- Consumes: 无（注入 deps）。
- Produces:
  - `interface RefreshTokenStore { read(): string | null; write(token: string): void; }`
  - `interface FeishuUserTokenProvider { getUserAccessToken(): Promise<string>; }`
  - `class FeishuUserTokenError extends Error`
  - `function createFeishuUserTokenProvider(deps: { appId: string; appSecret: string; seedRefreshToken: string; store: RefreshTokenStore; now?: () => number; fetchImpl?: typeof fetch; refreshSkewMs?: number; }): FeishuUserTokenProvider`

- [ ] **Step 1: 写失败测试**

`extensions/feishu/src/user-token.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import {
  createFeishuUserTokenProvider,
  FeishuUserTokenError,
  type RefreshTokenStore,
} from "./user-token.js";

function memStore(initial: string | null = null): RefreshTokenStore {
  let v = initial;
  return { read: () => v, write: (t) => { v = t; } };
}

// 两段式 fetch mock：app_access_token 接口 → oidc refresh 接口
function makeFetch(seq: Array<Record<string, unknown>>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const payload = seq[Math.min(i, seq.length - 1)];
    i += 1;
    return { ok: true, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const appTok = { code: 0, app_access_token: "app-tok", expire: 7200 };
const refreshed = (n: number) => ({
  code: 0,
  data: { access_token: `acc-${n}`, refresh_token: `ref-${n}`, expires_in: 7200 },
});

describe("createFeishuUserTokenProvider", () => {
  it("首次用 seed 刷新，落盘新 refresh_token，返回 access_token", async () => {
    const store = memStore(null);
    const { fetchImpl, calls } = makeFetch([appTok, refreshed(1)]);
    const p = createFeishuUserTokenProvider({
      appId: "a", appSecret: "s", seedRefreshToken: "seed",
      store, now: () => 1000, fetchImpl,
    });
    expect(await p.getUserAccessToken()).toBe("acc-1");
    expect(store.read()).toBe("ref-1");
    // 刷新请求带的是 seed
    expect(calls[1].body).toMatchObject({ grant_type: "refresh_token", refresh_token: "seed" });
  });

  it("access 未过期直接返回，不再刷新", async () => {
    const store = memStore(null);
    const { fetchImpl, calls } = makeFetch([appTok, refreshed(1)]);
    let t = 1000;
    const p = createFeishuUserTokenProvider({
      appId: "a", appSecret: "s", seedRefreshToken: "seed",
      store, now: () => t, fetchImpl, refreshSkewMs: 300_000,
    });
    await p.getUserAccessToken();
    const before = calls.length;
    t = 1000 + 3_600_000; // +1h，仍在 2h-5min 窗口内
    expect(await p.getUserAccessToken()).toBe("acc-1");
    expect(calls.length).toBe(before);
  });

  it("过期触发刷新，用落盘的最新 refresh_token 滚动", async () => {
    const store = memStore("disk-ref");
    const { fetchImpl, calls } = makeFetch([appTok, refreshed(1), appTok, refreshed(2)]);
    let t = 1000;
    const p = createFeishuUserTokenProvider({
      appId: "a", appSecret: "s", seedRefreshToken: "seed",
      store, now: () => t, fetchImpl, refreshSkewMs: 300_000,
    });
    await p.getUserAccessToken(); // 用 disk-ref 刷 → ref-1
    expect(calls[1].body).toMatchObject({ refresh_token: "disk-ref" });
    t = 1000 + 7_200_000; // 超过 expires_in
    expect(await p.getUserAccessToken()).toBe("acc-2");
    expect(calls[3].body).toMatchObject({ refresh_token: "ref-1" });
  });

  it("刷新失败抛 FeishuUserTokenError 且含提示", async () => {
    const store = memStore(null);
    const fetchImpl = (async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes("app_access_token")
          ? appTok
          : { code: 20037, msg: "refresh token expired" },
    })) as unknown as typeof fetch;
    const p = createFeishuUserTokenProvider({
      appId: "a", appSecret: "s", seedRefreshToken: "seed", store, now: () => 1, fetchImpl,
    });
    await expect(p.getUserAccessToken()).rejects.toBeInstanceOf(FeishuUserTokenError);
    await expect(p.getUserAccessToken()).rejects.toThrow(/重新.*授权|re-authorize/i);
  });

  it("并发调用只刷新一次", async () => {
    const store = memStore(null);
    const { fetchImpl, calls } = makeFetch([appTok, refreshed(1)]);
    const p = createFeishuUserTokenProvider({
      appId: "a", appSecret: "s", seedRefreshToken: "seed", store, now: () => 1, fetchImpl,
    });
    const [x, y] = await Promise.all([p.getUserAccessToken(), p.getUserAccessToken()]);
    expect(x).toBe("acc-1");
    expect(y).toBe("acc-1");
    // 只有一轮 app_access_token + 一轮 refresh = 2 次请求
    expect(calls.length).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/yb/landingAgent/wt-feishu-search && npx vitest run extensions/feishu/src/user-token.test.ts`
Expected: FAIL（Cannot find module './user-token.js'）

- [ ] **Step 3: 实现**

`extensions/feishu/src/user-token.ts`:
```ts
// landingAgent-specific (not upstream openclaw): user_access_token lifecycle
// for onboarding wiki search. Holds access_token in memory, persists the
// rolling refresh_token via an injected RefreshTokenStore.
const FEISHU_BASE = "https://open.feishu.cn";
const DEFAULT_SKEW_MS = 300_000;

export interface RefreshTokenStore {
  read(): string | null;
  write(token: string): void;
}

export interface FeishuUserTokenProvider {
  getUserAccessToken(): Promise<string>;
}

export class FeishuUserTokenError extends Error {
  readonly feishuCode?: number;
  constructor(message: string, feishuCode?: number) {
    super(message);
    this.name = "FeishuUserTokenError";
    this.feishuCode = feishuCode;
  }
}

type AppTokenResp = { code?: number; msg?: string; app_access_token?: string };
type RefreshResp = {
  code?: number;
  msg?: string;
  data?: { access_token?: string; refresh_token?: string; expires_in?: number };
};

export function createFeishuUserTokenProvider(deps: {
  appId: string;
  appSecret: string;
  seedRefreshToken: string;
  store: RefreshTokenStore;
  now?: () => number;
  fetchImpl?: typeof fetch;
  refreshSkewMs?: number;
}): FeishuUserTokenProvider {
  const now = deps.now ?? (() => Date.now());
  const doFetch = deps.fetchImpl ?? fetch;
  const skew = deps.refreshSkewMs ?? DEFAULT_SKEW_MS;

  let accessToken: string | null = null;
  let expiresAtMs = 0;
  let inFlight: Promise<string> | null = null;

  async function getAppAccessToken(): Promise<string> {
    const res = await doFetch(`${FEISHU_BASE}/open-apis/auth/v3/app_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: deps.appId, app_secret: deps.appSecret }),
    });
    const body = (await res.json()) as AppTokenResp;
    if (body.code !== 0 || !body.app_access_token) {
      throw new FeishuUserTokenError(
        `取 app_access_token 失败: ${body.msg ?? body.code}`,
        body.code,
      );
    }
    return body.app_access_token;
  }

  async function refresh(): Promise<string> {
    const appToken = await getAppAccessToken();
    const refreshToken = deps.store.read() ?? deps.seedRefreshToken;
    const res = await doFetch(`${FEISHU_BASE}/open-apis/authen/v1/oidc/refresh_access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${appToken}`,
      },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    const body = (await res.json()) as RefreshResp;
    const data = body.data;
    if (body.code !== 0 || !data?.access_token || !data.refresh_token) {
      throw new FeishuUserTokenError(
        `刷新 user_access_token 失败 (${body.code}: ${body.msg ?? ""})。` +
          `服务账号 refresh_token 可能已失效，需重新 OAuth 授权（见 docs/feishu-service-account-bootstrap.md / re-authorize）。`,
        body.code,
      );
    }
    try {
      deps.store.write(data.refresh_token);
    } catch {
      // 落盘失败降级：内存持有本次 refresh 结果，不中断当次请求。
    }
    accessToken = data.access_token;
    expiresAtMs = now() + (data.expires_in ?? 7200) * 1000;
    return accessToken;
  }

  return {
    async getUserAccessToken(): Promise<string> {
      if (accessToken && now() < expiresAtMs - skew) return accessToken;
      if (inFlight) return inFlight;
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/yb/landingAgent/wt-feishu-search && npx vitest run extensions/feishu/src/user-token.test.ts`
Expected: PASS（5 passed）

- [ ] **Step 5: Commit**

```bash
cd /Users/yb/landingAgent/wt-feishu-search
git add extensions/feishu/src/user-token.ts extensions/feishu/src/user-token.test.ts
git commit -m "feat(feishu): user_access_token provider with rolling refresh (TDD)"
```

---

### Task 2: 文件版 RefreshTokenStore（落盘持久化）

**Files:**
- Create: `extensions/feishu/src/file-refresh-store.ts`
- Test: `extensions/feishu/src/file-refresh-store.test.ts`

**Interfaces:**
- Consumes: `RefreshTokenStore` from `./user-token.js`。
- Produces: `function createFileRefreshTokenStore(path: string): RefreshTokenStore`

- [ ] **Step 1: 写失败测试**

`extensions/feishu/src/file-refresh-store.test.ts`:
```ts
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFileRefreshTokenStore } from "./file-refresh-store.js";

describe("createFileRefreshTokenStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "feishu-rt-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("文件不存在时 read 返回 null", () => {
    const store = createFileRefreshTokenStore(join(dir, "sub", "t.json"));
    expect(store.read()).toBeNull();
  });

  it("write 后 read 能取回，落 JSON，权限 0600", () => {
    const path = join(dir, "sub", "t.json");
    const store = createFileRefreshTokenStore(path);
    store.write("ref-abc");
    expect(store.read()).toBe("ref-abc");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.refresh_token).toBe("ref-abc");
    expect(typeof parsed.updated_at).toBe("number");
    // 权限低 6 位 == 600
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("write 覆盖旧值", () => {
    const path = join(dir, "t.json");
    const store = createFileRefreshTokenStore(path);
    store.write("first");
    store.write("second");
    expect(store.read()).toBe("second");
    expect(existsSync(`${path}.tmp`)).toBe(false); // 临时文件已 rename 掉
  });

  it("坏 JSON 时 read 返回 null 不抛", () => {
    const path = join(dir, "t.json");
    const store = createFileRefreshTokenStore(path);
    store.write("ok");
    // 手动写坏
    require("node:fs").writeFileSync(path, "{not json");
    expect(store.read()).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/yb/landingAgent/wt-feishu-search && npx vitest run extensions/feishu/src/file-refresh-store.test.ts`
Expected: FAIL（Cannot find module './file-refresh-store.js'）

- [ ] **Step 3: 实现**

`extensions/feishu/src/file-refresh-store.ts`:
```ts
// landingAgent-specific (not upstream openclaw): file-backed RefreshTokenStore.
// Atomic write (temp file + rename), 0600 perms.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RefreshTokenStore } from "./user-token.js";

export function createFileRefreshTokenStore(path: string): RefreshTokenStore {
  return {
    read(): string | null {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { refresh_token?: unknown };
        return typeof parsed.refresh_token === "string" ? parsed.refresh_token : null;
      } catch {
        return null;
      }
    },
    write(token: string): void {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ refresh_token: token, updated_at: Date.now() }), {
        mode: 0o600,
      });
      renameSync(tmp, path);
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/yb/landingAgent/wt-feishu-search && npx vitest run extensions/feishu/src/file-refresh-store.test.ts`
Expected: PASS（4 passed）

- [ ] **Step 5: Commit**

```bash
cd /Users/yb/landingAgent/wt-feishu-search
git add extensions/feishu/src/file-refresh-store.ts extensions/feishu/src/file-refresh-store.test.ts
git commit -m "feat(feishu): file-backed refresh_token store (atomic, 0600)"
```

---

### Task 3: searchWikiNodes（搜索改 wiki 节点 + user token）

**Files:**
- Modify: `extensions/feishu/src/search.ts`
- Test: `extensions/feishu/src/search.wiki.test.ts`（新，不动现有 search 测试）

**Interfaces:**
- Consumes: `FeishuUserTokenProvider` 的 `getUserAccessToken`（此处按 `() => Promise<string>` 注入）。
- Produces:
  - `FeishuSearchResultItem` 增补可选 `objToken?: string; objType?: string;`
  - `function searchWikiNodes(deps: { getUserAccessToken: () => Promise<string>; fetchImpl?: typeof fetch; spaceId?: string; }, query: string, limit: number): Promise<FeishuSearchResult>`

- [ ] **Step 1: 写失败测试**

`extensions/feishu/src/search.wiki.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { searchWikiNodes } from "./search.js";

function fakeFetch(payload: unknown, capture?: (url: string, body: unknown) => void) {
  return (async (url: string, init?: { body?: string }) => {
    capture?.(url, init?.body ? JSON.parse(init.body) : undefined);
    return { ok: true, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
}

const wikiResp = {
  code: 0,
  data: {
    items: [
      {
        node_id: "wikcnAAA",
        space_id: "7065",
        obj_token: "doccnXXX",
        obj_type: "doc",
        title: "TTC制度07-1 Billing",
        url: "https://x.feishu.cn/wiki/wikcnAAA",
      },
      {
        node_id: "wikcnBBB",
        space_id: "7065",
        obj_token: "docxYYY",
        obj_type: "docx",
        title: "报销制度",
        url: "https://x.feishu.cn/wiki/wikcnBBB",
      },
    ],
  },
};

describe("searchWikiNodes", () => {
  it("映射 wiki 节点为 FeishuSearchResult（含 objToken/objType）", async () => {
    const r = await searchWikiNodes(
      { getUserAccessToken: async () => "user-tok", fetchImpl: fakeFetch(wikiResp) },
      "billing",
      10,
    );
    expect(r.query).toBe("billing");
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toMatchObject({
      title: "TTC制度07-1 Billing",
      token: "wikcnAAA",
      objToken: "doccnXXX",
      objType: "doc",
      url: "https://x.feishu.cn/wiki/wikcnAAA",
    });
  });

  it("带 spaceId 时请求体含 space_id，limit 截断", async () => {
    let seenBody: any;
    const r = await searchWikiNodes(
      {
        getUserAccessToken: async () => "user-tok",
        fetchImpl: fakeFetch(wikiResp, (_u, b) => (seenBody = b)),
        spaceId: "7065",
      },
      "billing",
      1,
    );
    expect(seenBody).toMatchObject({ query: "billing", space_id: "7065" });
    expect(r.results).toHaveLength(1);
  });

  it("飞书非 0 抛错", async () => {
    await expect(
      searchWikiNodes(
        { getUserAccessToken: async () => "t", fetchImpl: fakeFetch({ code: 99991663, msg: "bad token" }) },
        "x",
        10,
      ),
    ).rejects.toThrow(/bad token|99991663/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/yb/landingAgent/wt-feishu-search && npx vitest run extensions/feishu/src/search.wiki.test.ts`
Expected: FAIL（searchWikiNodes is not exported）

- [ ] **Step 3: 实现**

在 `extensions/feishu/src/search.ts` 顶部常量后加常量、扩展 `FeishuSearchResultItem`、新增 `searchWikiNodes`。先把 item 类型补两字段：

```ts
export type FeishuSearchResultItem = {
  type: string;
  title: string;
  url: string;
  token: string;
  summary?: string;
  ownerName?: string;
  updateTime?: number;
  objToken?: string;
  objType?: string;
};
```

新增（放在 `searchDocs` 之后）：
```ts
const FEISHU_BASE = "https://open.feishu.cn";

type WikiSearchNode = {
  node_id?: string;
  node_token?: string;
  space_id?: string;
  obj_token?: string;
  obj_type?: string;
  title?: string;
  url?: string;
};
type WikiSearchResponse = {
  code?: number;
  msg?: string;
  data?: { items?: WikiSearchNode[] };
};

/**
 * landingAgent-specific: search wiki knowledge-base nodes with a
 * user_access_token (wiki/v1/nodes/search). tenant token cannot reach
 * enterprise-public wiki content; only a user identity can.
 */
export async function searchWikiNodes(
  deps: {
    getUserAccessToken: () => Promise<string>;
    fetchImpl?: typeof fetch;
    spaceId?: string;
  },
  query: string,
  limit: number,
): Promise<FeishuSearchResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const token = await deps.getUserAccessToken();
  const body: Record<string, unknown> = { query };
  if (deps.spaceId) body.space_id = deps.spaceId;
  const res = await doFetch(`${FEISHU_BASE}/open-apis/wiki/v1/nodes/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as WikiSearchResponse;
  if (json.code !== 0) {
    throw new Error(`feishu wiki search failed (${json.code}): ${json.msg ?? ""}`);
  }
  const items = json.data?.items ?? [];
  const results: FeishuSearchResultItem[] = items.slice(0, clampLimit(limit)).map((n) => {
    const item: FeishuSearchResultItem = {
      type: n.obj_type ?? "",
      title: stripHighlight(n.title),
      url: n.url ?? "",
      token: n.node_token ?? n.node_id ?? "",
    };
    if (n.obj_token) item.objToken = n.obj_token;
    if (n.obj_type) item.objType = n.obj_type;
    return item;
  });
  return { query, total: results.length, results };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/yb/landingAgent/wt-feishu-search && npx vitest run extensions/feishu/src/search.wiki.test.ts extensions/feishu/src/search.test.ts`
Expected: PASS（新老搜索测试都过；现有 search.test.ts 不受影响）

- [ ] **Step 5: Commit**

```bash
cd /Users/yb/landingAgent/wt-feishu-search
git add extensions/feishu/src/search.ts extensions/feishu/src/search.wiki.test.ts
git commit -m "feat(feishu): searchWikiNodes via user_access_token (wiki/v1/nodes/search)"
```

---

### Task 4: readWikiDocContent（按 obj_type 分派读正文）

**Files:**
- Create: `extensions/feishu/src/onboarding-doc-read.ts`
- Test: `extensions/feishu/src/onboarding-doc-read.test.ts`

**Interfaces:**
- Consumes: `() => Promise<string>` user token getter。
- Produces: `function readWikiDocContent(deps: { getUserAccessToken: () => Promise<string>; fetchImpl?: typeof fetch; }, objToken: string, objType: string): Promise<string>`

- [ ] **Step 1: 写失败测试**

`extensions/feishu/src/onboarding-doc-read.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readWikiDocContent } from "./onboarding-doc-read.js";

function fetchFor(map: Record<string, unknown>) {
  return (async (url: string) => {
    const key = Object.keys(map).find((k) => url.includes(k));
    return { ok: true, json: async () => (key ? map[key] : { code: 1, msg: "no route" }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("readWikiDocContent", () => {
  it("docx 走 docx/v1/documents/{token}/raw_content", async () => {
    const fetchImpl = fetchFor({
      "/docx/v1/documents/docxYYY/raw_content": { code: 0, data: { content: "docx 正文" } },
    });
    const out = await readWikiDocContent(
      { getUserAccessToken: async () => "t", fetchImpl },
      "docxYYY",
      "docx",
    );
    expect(out).toBe("docx 正文");
  });

  it("老版 doc 走 doc/v2/{token}/raw_content", async () => {
    const fetchImpl = fetchFor({
      "/doc/v2/doccnXXX/raw_content": { code: 0, data: { content: "老版 doc 正文" } },
    });
    const out = await readWikiDocContent(
      { getUserAccessToken: async () => "t", fetchImpl },
      "doccnXXX",
      "doc",
    );
    expect(out).toBe("老版 doc 正文");
  });

  it("未知类型抛错", async () => {
    await expect(
      readWikiDocContent({ getUserAccessToken: async () => "t", fetchImpl: fetchFor({}) }, "x", "sheet"),
    ).rejects.toThrow(/不支持|unsupported/i);
  });

  it("飞书非 0 抛错", async () => {
    const fetchImpl = fetchFor({
      "/docx/v1/documents/x/raw_content": { code: 131006, msg: "permission denied" },
    });
    await expect(
      readWikiDocContent({ getUserAccessToken: async () => "t", fetchImpl }, "x", "docx"),
    ).rejects.toThrow(/permission denied|131006/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/yb/landingAgent/wt-feishu-search && npx vitest run extensions/feishu/src/onboarding-doc-read.test.ts`
Expected: FAIL（Cannot find module './onboarding-doc-read.js'）

- [ ] **Step 3: 实现**

`extensions/feishu/src/onboarding-doc-read.ts`:
```ts
// landingAgent-specific (not upstream openclaw): read a wiki doc's raw text
// with a user_access_token, dispatching by obj_type. Legacy "doc" (doccn...)
// uses doc/v2; new "docx" uses docx/v1.
const FEISHU_BASE = "https://open.feishu.cn";

type RawContentResponse = { code?: number; msg?: string; data?: { content?: string } };

export async function readWikiDocContent(
  deps: { getUserAccessToken: () => Promise<string>; fetchImpl?: typeof fetch },
  objToken: string,
  objType: string,
): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch;
  let url: string;
  if (objType === "docx") {
    url = `${FEISHU_BASE}/open-apis/docx/v1/documents/${objToken}/raw_content`;
  } else if (objType === "doc") {
    url = `${FEISHU_BASE}/open-apis/doc/v2/${objToken}/raw_content`;
  } else {
    throw new Error(`暂不支持读取该类型文档（unsupported obj_type）: ${objType}`);
  }
  const token = await deps.getUserAccessToken();
  const res = await doFetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json()) as RawContentResponse;
  if (json.code !== 0) {
    throw new Error(`feishu read doc failed (${json.code}): ${json.msg ?? ""}`);
  }
  return json.data?.content ?? "";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/yb/landingAgent/wt-feishu-search && npx vitest run extensions/feishu/src/onboarding-doc-read.test.ts`
Expected: PASS（4 passed）

- [ ] **Step 5: Commit**

```bash
cd /Users/yb/landingAgent/wt-feishu-search
git add extensions/feishu/src/onboarding-doc-read.ts extensions/feishu/src/onboarding-doc-read.test.ts
git commit -m "feat(feishu): read wiki doc content by obj_type (doc/v2 + docx/v1)"
```

---

### Task 5: 配置接线 + 引导脚本/runbook

把 provider/搜索/读取接进 `feishu_search` 工具，并让 onboarding 读取可用；仅当账号配了 `onboardingSearch.seedRefreshToken` 时启用 user-token 路径，否则保持原 tenant 行为。

**Files:**
- Modify: `extensions/feishu/src/config-schema.ts`（新增 `onboardingSearch` 账号级配置）
- Modify: `extensions/feishu/src/search.ts`（`registerFeishuSearchTools` 里按配置选路）
- Test: `extensions/feishu/src/search.register.test.ts`（新，验证选路）
- Create: `scripts/feishu-exchange-refresh.mjs`
- Create: `docs/feishu-service-account-bootstrap.md`

**Interfaces:**
- Consumes: `createFeishuUserTokenProvider`（Task1）、`createFileRefreshTokenStore`（Task2）、`searchWikiNodes`（Task3）、`readWikiDocContent`（Task4）、`resolveFeishuCredentials(cfg)` → `{appId,appSecret}`（现有 `accounts.ts`）。
- Produces:
  - config 类型 `FeishuOnboardingSearchConfig = { seedRefreshToken?: string; refreshTokenStorePath?: string; spaceId?: string }`
  - `function resolveOnboardingSearch(account): { provider; spaceId?: string } | null`（在 search.ts 内部导出，供工具与测试用）

- [ ] **Step 1: 写失败测试**

`extensions/feishu/src/search.register.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolveOnboardingSearch } from "./search.js";

describe("resolveOnboardingSearch", () => {
  it("未配 seedRefreshToken → 返回 null（走原 tenant 搜索）", () => {
    const account: any = { appId: "a", appSecret: "s", config: { onboardingSearch: {} } };
    expect(resolveOnboardingSearch(account)).toBeNull();
  });

  it("配了 seedRefreshToken → 返回 provider + spaceId", () => {
    const account: any = {
      appId: "a",
      appSecret: "s",
      config: {
        onboardingSearch: {
          seedRefreshToken: "seed",
          refreshTokenStorePath: "/tmp/does-not-write-until-refresh.json",
          spaceId: "7065",
        },
      },
    };
    const r = resolveOnboardingSearch(account);
    expect(r).not.toBeNull();
    expect(r!.spaceId).toBe("7065");
    expect(typeof r!.provider.getUserAccessToken).toBe("function");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/yb/landingAgent/wt-feishu-search && npx vitest run extensions/feishu/src/search.register.test.ts`
Expected: FAIL（resolveOnboardingSearch is not exported）

- [ ] **Step 3a: config-schema 加字段**

在 `extensions/feishu/src/config-schema.ts` 里，账号 tools/config 同层新增（找到账号 config typebox 对象，追加属性）：
```ts
onboardingSearch: Type.Optional(
  Type.Object({
    seedRefreshToken: Type.Optional(Type.String()),
    refreshTokenStorePath: Type.Optional(Type.String()),
    spaceId: Type.Optional(Type.String()),
  }),
),
```
> 注：seedRefreshToken 允许 secretRef，解析走既有 secret 机制；此处 schema 只声明为可选字符串（解析后的值）。若该 schema 用了严格 additionalProperties，需把此属性加进对应对象定义处。

- [ ] **Step 3b: search.ts 接线**

在 `search.ts` 顶部 import：
```ts
import { createFeishuUserTokenProvider, type FeishuUserTokenProvider } from "./user-token.js";
import { createFileRefreshTokenStore } from "./file-refresh-store.js";
import { readWikiDocContent } from "./onboarding-doc-read.js";
import { resolveFeishuCredentials } from "./accounts.js";
import { homedir } from "node:os";
import { join } from "node:path";
```

新增导出（放在 `registerFeishuSearchTools` 之前）：
```ts
type OnboardingSearchAccountLike = {
  appId?: string;
  appSecret?: string;
  config?: { onboardingSearch?: { seedRefreshToken?: string; refreshTokenStorePath?: string; spaceId?: string } };
};

export function resolveOnboardingSearch(
  account: OnboardingSearchAccountLike,
): { provider: FeishuUserTokenProvider; spaceId?: string } | null {
  const cfg = account.config?.onboardingSearch;
  if (!cfg?.seedRefreshToken || !account.appId || !account.appSecret) return null;
  const storePath =
    cfg.refreshTokenStorePath ?? join(homedir(), ".openclaw", "feishu-user-token.json");
  const provider = createFeishuUserTokenProvider({
    appId: account.appId,
    appSecret: account.appSecret,
    seedRefreshToken: cfg.seedRefreshToken,
    store: createFileRefreshTokenStore(storePath),
  });
  return cfg.spaceId ? { provider, spaceId: cfg.spaceId } : { provider };
}
```

在 `registerFeishuSearchTools` 的 `execute` 里改选路（替换现有 `searchDocs` 调用块）：
```ts
async execute(_toolCallId, params) {
  const p = params as { query: string; limit?: number; accountId?: string };
  try {
    const account = resolveFeishuToolAccount({
      api,
      executeParams: p,
      defaultAccountId,
      requiredTool: { family: "search", label: "Search" },
    });
    const onboarding = resolveOnboardingSearch(account as OnboardingSearchAccountLike);
    if (onboarding) {
      return jsonResult(
        await searchWikiNodes(
          {
            getUserAccessToken: () => onboarding.provider.getUserAccessToken(),
            spaceId: onboarding.spaceId,
          },
          p.query,
          p.limit ?? 10,
        ),
      );
    }
    const client = createFeishuClient(account); // 原 tenant 路
    return jsonResult(await searchDocs(client, p.query, p.limit ?? 10));
  } catch (err) {
    return toolExecutionErrorResult(err);
  }
},
```
> 说明：现有代码用 `createFeishuToolClient({...})` 一步到位。为拿到 `account` 供 `resolveOnboardingSearch` 判断，改为先 `resolveFeishuToolAccount(...)` 拿 account、再 `createFeishuClient(account)`（`client.ts` 已导出）。`resolveFeishuToolAccount` 与 `createFeishuClient` 均已存在于 `tool-account.ts` / `client.ts`，import 补上即可；直接用 `createFeishuClient(account)`（保持原 tenant 行为）。

- [ ] **Step 3c: 引导脚本**

`scripts/feishu-exchange-refresh.mjs`:
```js
#!/usr/bin/env node
// One-time: exchange an OAuth authorization_code for a seed refresh_token.
// Usage: node scripts/feishu-exchange-refresh.mjs <appId> <appSecret> <code>
const [, , appId, appSecret, code] = process.argv;
if (!appId || !appSecret || !code) {
  console.error("usage: node scripts/feishu-exchange-refresh.mjs <appId> <appSecret> <code>");
  process.exit(1);
}
const BASE = "https://open.feishu.cn";
const appRes = await fetch(`${BASE}/open-apis/auth/v3/app_access_token/internal`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const app = await appRes.json();
if (app.code !== 0) throw new Error(`app_access_token failed: ${JSON.stringify(app)}`);
const tokRes = await fetch(`${BASE}/open-apis/authen/v1/oidc/access_token`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${app.app_access_token}` },
  body: JSON.stringify({ grant_type: "authorization_code", code }),
});
const tok = await tokRes.json();
if (tok.code !== 0) throw new Error(`oidc access_token failed: ${JSON.stringify(tok)}`);
console.log("refresh_token:", tok.data.refresh_token);
console.log("scope:", tok.data.scope);
console.log("expires_in(access):", tok.data.expires_in);
```

- [ ] **Step 3d: runbook**

`docs/feishu-service-account-bootstrap.md`：写清 5 步（建专用账号 → 开用户身份 scope → 该账号授权拿 code → 跑脚本得 refresh_token → 写进 BCC `.env` 的 `FEISHU_ONBOARDING_REFRESH_TOKEN` 并在 `openclaw.json` 用 secretRef 引到账号 `onboardingSearch.seedRefreshToken`、可选配 `spaceId=7065297004640878595`、重启 gateway）。含「30 天以上无活动需重跑」提示。

- [ ] **Step 4: 跑测试确认通过 + 全量校验**

Run:
```bash
cd /Users/yb/landingAgent/wt-feishu-search
npx vitest run extensions/feishu/src/search.register.test.ts
pnpm tsgo
pnpm lint
```
Expected: 选路测试 PASS；tsgo 无类型错；lint 通过。

- [ ] **Step 5: Commit**

```bash
cd /Users/yb/landingAgent/wt-feishu-search
git add extensions/feishu/src/config-schema.ts extensions/feishu/src/search.ts \
  extensions/feishu/src/search.register.test.ts scripts/feishu-exchange-refresh.mjs \
  docs/feishu-service-account-bootstrap.md
git commit -m "feat(feishu): wire user-token onboarding search into feishu_search + bootstrap"
```

---

## 部署（计划外，实现完成后单独一步）

镜像重建走 self-hosted runner（push `feat/feishu-search` 合入后 push main）。在 BCC `.env` 加 `FEISHU_ONBOARDING_REFRESH_TOKEN`，`openclaw.json` 账号加 `onboardingSearch`（secretRef 引 env + spaceId）。重启后端到端验证：私聊问「什么是 billing」→ 机器人搜到 TTC 制度 → 读正文 → 引用真实定义作答。
