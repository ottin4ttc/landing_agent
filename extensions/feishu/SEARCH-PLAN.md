# feishu_search 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `extensions/feishu` 加一个 `feishu_search` agent 工具，调飞书 `client.search.docWiki.search` 检索云文档+wiki，返回统一结果。

**Architecture:** 一个内部函数 `searchDocs(client, query, limit)`（调 SDK、映射 `res_units`→统一结构、非 0 code 抛错）+ 工具注册 `registerFeishuSearchTools` + tools-config 新增 `search` family + plugin.json 注册。openclaw 核心零改动，全部在 `extensions/feishu/`。

**Tech Stack:** TypeScript(ESM)、`@larksuiteoapi/node-sdk`（原生 `Lark.Client`，插件已依赖）、TypeBox（工具参数 schema）、vitest。

## Global Constraints

- 只改 `extensions/feishu/` 下文件，**不动 openclaw 核心 `src/`**。
- 飞书 SDK：`createFeishuToolClient(...)` 返回**原生 `Lark.Client`**，直接 `await client.search.docWiki.search({ data: { query, page_size } })`。
- **响应形状（SDK 实测类型，权威）**：`res.code`（!==0 抛 `new Error(res.msg)`）、`res.data.total`、`res.data.res_units[]`；每 unit：`title_highlighted`、`summary_highlighted`、`entity_type("DOC"|"WIKI")`、`result_meta { doc_types, url, token, owner_name, update_time }`。**请求里 `page_size` 在 `data` 下，不是 `params`。**
- 错误处理遵循仓库红线：非 0 code 抛错、不静默吞；execute 层用 `toolExecutionErrorResult(err)` 包装。
- `limit` 默认 10、截断到 [1,50]。空结果返回 `{ query, total:0, results:[] }`。
- 工具参数 schema 用 TypeBox（照现有 `*-schema.ts`）。
- 测试：新文件 `extensions/feishu/src/search.test.ts` 会被 `test/vitest/vitest.extension-feishu.config.ts` 自动纳入。mock `./tool-account.js` 注入假 client，不打真网络。
- 跑测试（worktree 需先 `pnpm install`）：
  - 单文件：`node scripts/run-vitest.mjs run --config test/vitest/vitest.extension-feishu.config.ts extensions/feishu/src/search.test.ts`
  - 全包：`node scripts/test-projects.mjs test/vitest/vitest.extension-feishu.config.ts`

---

### Task 1: search-schema + searchDocs（核心逻辑，TDD）

**Files:**

- Create: `extensions/feishu/src/search-schema.ts`
- Create: `extensions/feishu/src/search.ts`（本任务只写 `searchDocs` + `stripHighlight` + 类型；`registerFeishuSearchTools` 在 Task 3 加）
- Test: `extensions/feishu/src/search.test.ts`

**Interfaces:**

- Produces: `export type FeishuSearchResultItem = { type: string; title: string; url: string; token: string; summary?: string; ownerName?: string; updateTime?: number }`
- Produces: `export type FeishuSearchResult = { query: string; total: number; results: FeishuSearchResultItem[] }`
- Produces: `export function stripHighlight(s: string | undefined): string`
- Produces: `export async function searchDocs(client: Lark.Client, query: string, limit: number): Promise<FeishuSearchResult>`
- Produces: `export const FeishuSearchSchema`（TypeBox object: `query: string`（min 1）, `limit?: number`）

- [ ] **Step 1: Write the failing test** — `extensions/feishu/src/search.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { searchDocs, stripHighlight } from "./search.ts";

function fakeClient(searchImpl: (payload: unknown) => Promise<unknown>) {
  return {
    search: { docWiki: { search: vi.fn(searchImpl) } },
  } as unknown as import("@larksuiteoapi/node-sdk").Client;
}

describe("stripHighlight", () => {
  it("removes em tags and trims", () => {
    expect(stripHighlight("<em>季度</em>报告")).toBe("季度报告");
    expect(stripHighlight(undefined)).toBe("");
  });
});

describe("searchDocs", () => {
  it("maps res_units to unified results and passes page_size in data", async () => {
    const search = vi.fn(async () => ({
      code: 0,
      msg: "success",
      data: {
        total: 2,
        res_units: [
          {
            title_highlighted: "<em>季度</em>报告",
            summary_highlighted: "Q3 摘要",
            entity_type: "DOC",
            result_meta: {
              doc_types: "DOCX",
              url: "https://feishu.cn/docx/aaa",
              token: "aaa",
              owner_name: "张三",
              update_time: 111,
            },
          },
          {
            title_highlighted: "Wiki 首页",
            entity_type: "WIKI",
            result_meta: { doc_types: "WIKI", url: "https://feishu.cn/wiki/bbb", token: "bbb" },
          },
        ],
      },
    }));
    const client = { search: { docWiki: { search } } } as any;
    const res = await searchDocs(client, "报告", 10);
    expect(search).toHaveBeenCalledWith({ data: { query: "报告", page_size: 10 } });
    expect(res).toEqual({
      query: "报告",
      total: 2,
      results: [
        {
          type: "DOCX",
          title: "季度报告",
          url: "https://feishu.cn/docx/aaa",
          token: "aaa",
          summary: "Q3 摘要",
          ownerName: "张三",
          updateTime: 111,
        },
        { type: "WIKI", title: "Wiki 首页", url: "https://feishu.cn/wiki/bbb", token: "bbb" },
      ],
    });
  });

  it("returns empty result set (total 0) without error", async () => {
    const client = fakeClient(async () => ({ code: 0, data: { total: 0, has_more: false } }));
    const res = await searchDocs(client, "无", 10);
    expect(res).toEqual({ query: "无", total: 0, results: [] });
  });

  it("throws with feishu msg on non-zero code (no swallow)", async () => {
    const client = fakeClient(async () => ({
      code: 99991672,
      msg: "Access denied. scope required: search:docs:read",
    }));
    await expect(searchDocs(client, "x", 10)).rejects.toThrow(/search:docs:read/);
  });

  it("clamps limit to [1,50]", async () => {
    const search = vi.fn(async () => ({ code: 0, data: { total: 0 } }));
    const client = { search: { docWiki: { search } } } as any;
    await searchDocs(client, "x", 999);
    expect(search).toHaveBeenCalledWith({ data: { query: "x", page_size: 50 } });
    await searchDocs(client, "x", 0);
    expect(search).toHaveBeenCalledWith({ data: { query: "x", page_size: 1 } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `node scripts/run-vitest.mjs run --config test/vitest/vitest.extension-feishu.config.ts extensions/feishu/src/search.test.ts` — Expected: FAIL (module `./search.ts` not found).

- [ ] **Step 3: Implement** — `extensions/feishu/src/search-schema.ts`

```ts
// Feishu search tool parameter schema.
import { Type } from "@sinclair/typebox";

export const FeishuSearchSchema = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Keyword to search feishu cloud docs and wiki.",
  }),
  limit: Type.Optional(
    Type.Number({ minimum: 1, maximum: 50, description: "Max results (default 10)." }),
  ),
});
```

（若现有 `*-schema.ts` 的 TypeBox 导入路径不同，以仓库内实际用法为准——照 `wiki-schema.ts` 的 import。）

`extensions/feishu/src/search.ts`（本任务部分）:

```ts
// Feishu content search: aggregate agent tool over search/v2/doc_wiki/search.
import type * as Lark from "@larksuiteoapi/node-sdk";

export type FeishuSearchResultItem = {
  type: string;
  title: string;
  url: string;
  token: string;
  summary?: string;
  ownerName?: string;
  updateTime?: number;
};
export type FeishuSearchResult = {
  query: string;
  total: number;
  results: FeishuSearchResultItem[];
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export function stripHighlight(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/<[^>]+>/g, "").trim();
}

function clampLimit(limit: number | undefined): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

export async function searchDocs(
  client: Lark.Client,
  query: string,
  limit: number,
): Promise<FeishuSearchResult> {
  const pageSize = clampLimit(limit);
  const res = (await client.search.docWiki.search({ data: { query, page_size: pageSize } })) as {
    code?: number;
    msg?: string;
    data?: {
      total?: number;
      res_units?: Array<{
        title_highlighted?: string;
        summary_highlighted?: string;
        entity_type?: string;
        result_meta?: {
          doc_types?: string;
          url?: string;
          token?: string;
          owner_name?: string;
          update_time?: number;
        };
      }>;
    };
  };
  if (res.code !== 0) {
    throw new Error(res.msg || `feishu search failed with code ${res.code}`);
  }
  const units = res.data?.res_units ?? [];
  const results: FeishuSearchResultItem[] = units.map((u) => {
    const m = u.result_meta ?? {};
    const item: FeishuSearchResultItem = {
      type: m.doc_types ?? u.entity_type ?? "",
      title: stripHighlight(u.title_highlighted),
      url: m.url ?? "",
      token: m.token ?? "",
    };
    const summary = stripHighlight(u.summary_highlighted);
    if (summary) item.summary = summary;
    if (m.owner_name) item.ownerName = m.owner_name;
    if (typeof m.update_time === "number") item.updateTime = m.update_time;
    return item;
  });
  return { query, total: res.data?.total ?? results.length, results };
}
```

- [ ] **Step 4: Run test to verify it passes** — same command — Expected: PASS (4 tests + stripHighlight).
- [ ] **Step 5: Commit** — `git add extensions/feishu/src/search.ts extensions/feishu/src/search-schema.ts extensions/feishu/src/search.test.ts && git commit -m "feat(feishu): searchDocs over doc_wiki search + schema"`

---

### Task 2: tools-config 新增 `search` family

**Files:**

- Modify: `extensions/feishu/src/types.ts`（`FeishuToolsConfig` 加 `search?: boolean`）
- Modify: `extensions/feishu/src/tools-config.ts`（`DEFAULT_TOOLS_CONFIG` 加 `search: true`）
- Modify: `extensions/feishu/src/tool-account.ts`（`resolveAnyEnabledFeishuToolsConfig` 的 merged 初值加 `search: false`，循环加 `merged.search = merged.search || cfg.search`）

**Interfaces:**

- Produces: `FeishuToolsConfig.search`、默认开、`resolveAnyEnabledFeishuToolsConfig` 返回值含 `search`。

- [ ] **Step 1: Write the failing test** — 追加到 `extensions/feishu/src/tools-config.test.ts`（若不存在则新建）

```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_TOOLS_CONFIG, resolveToolsConfig } from "./tools-config.ts";

describe("tools-config search family", () => {
  it("search defaults to true", () => {
    expect(DEFAULT_TOOLS_CONFIG.search).toBe(true);
    expect(resolveToolsConfig(undefined).search).toBe(true);
    expect(resolveToolsConfig({ search: false }).search).toBe(false);
  });
});
```

（`resolveToolsConfig` 的确切导出名/签名以 `tools-config.ts` 现有为准；若签名不同，按现有函数调整断言，但必须断 `search` 默认 true 且可被 `{search:false}` 覆盖。）

- [ ] **Step 2: Run → FAIL**（`search` 不存在，类型/值错）
- [ ] **Step 3: Implement**

`extensions/feishu/src/types.ts` — `FeishuToolsConfig` 加字段（放在 `bitable?`/`base?` 之后）：

```ts
  search?: boolean;
```

`extensions/feishu/src/tools-config.ts` — `DEFAULT_TOOLS_CONFIG`（类型 `Required<FeishuToolsConfig>`）加：

```ts
  search: true,
```

`extensions/feishu/src/tool-account.ts` — `resolveAnyEnabledFeishuToolsConfig` 的 `merged` 初值对象加 `search: false,`；在合并各账号 cfg 的区块内加：

```ts
merged.search = merged.search || cfg.search;
```

- [ ] **Step 4: Run → PASS**；并 `node scripts/run-tsgo.mjs` 相关或 `pnpm tsgo`（确认 `Required<FeishuToolsConfig>` 无缺字段报错）。
- [ ] **Step 5: Commit** — `git commit -am "feat(feishu): add search tools-config family (default on)"`

---

### Task 3: 注册 feishu_search 工具 + 装配 + plugin.json

**Files:**

- Modify: `extensions/feishu/src/search.ts`（加 `registerFeishuSearchTools`）
- Modify: `extensions/feishu/api.ts`（export barrel 加一行）
- Modify: `extensions/feishu/index.ts`（wrapper + `registerFull` 挂载）
- Modify: `extensions/feishu/openclaw.plugin.json`（`contracts.tools` + `toolMetadata`）
- Test: 追加到 `extensions/feishu/src/search.test.ts`（execute 层）

**Interfaces:**

- Consumes: `searchDocs`（Task 1）, `FeishuSearchSchema`（Task 1）, `createFeishuToolClient`+`resolveAnyEnabledFeishuToolsConfig`（Task 2 的 `search` family）
- Produces: `export function registerFeishuSearchTools(api: OpenClawPluginApi): void`

- [ ] **Step 1: Write the failing test** — 追加 execute-层测试到 `search.test.ts`（照 `wiki.test.ts` 的 mock 模式）

```ts
import { registerFeishuSearchTools } from "./search.ts";
// 顶部加：
const createFeishuToolClientMock = vi.hoisted(() => vi.fn());
const resolveAnyEnabledFeishuToolsConfigMock = vi.hoisted(() => vi.fn());
vi.mock("./tool-account.ts", () => ({
  createFeishuToolClient: createFeishuToolClientMock,
  resolveAnyEnabledFeishuToolsConfig: resolveAnyEnabledFeishuToolsConfigMock,
}));

describe("feishu_search tool execute", () => {
  it("registers and returns mapped results in result.details", async () => {
    resolveAnyEnabledFeishuToolsConfigMock.mockReturnValue({ search: true });
    const search = vi.fn(async () => ({
      code: 0,
      data: {
        total: 1,
        res_units: [
          {
            title_highlighted: "标题",
            entity_type: "DOC",
            result_meta: { doc_types: "DOCX", url: "u", token: "t" },
          },
        ],
      },
    }));
    createFeishuToolClientMock.mockReturnValue({ search: { docWiki: { search } } });
    const registerTool = vi.fn();
    const api: any = {
      config: {
        channels: { feishu: { appId: "a", appSecret: "s", tools: { search: true }, accounts: {} } },
      },
      registerTool,
    };
    registerFeishuSearchTools(api);
    const factory = registerTool.mock.calls[0]?.[0];
    const tool = factory({ agentAccountId: undefined });
    expect(tool.name).toBe("feishu_search");
    const result: any = await tool.execute("call-1", { query: "标题", limit: 10 });
    expect(result.details).toMatchObject({
      query: "标题",
      total: 1,
      results: [{ type: "DOCX", title: "标题", url: "u", token: "t" }],
    });
  });
});
```

（`api.config` 的确切最小形状照 `wiki.test.ts` 里 `createTestPluginApi` 的用法调整——若直接手搓 api 对象不满足 `listEnabledFeishuAccounts`，改用 `createTestPluginApi` from `"openclaw/plugin-sdk/plugin-test-api"` 并塞 `channels.feishu.tools.search=true`，参照 wiki.test.ts:27-46。断言目标不变。）

- [ ] **Step 2: Run → FAIL**（`registerFeishuSearchTools` 未定义）
- [ ] **Step 3: Implement**

`extensions/feishu/src/search.ts` 追加（import 照 `wiki.ts:1-9`：`OpenClawPluginApi` from `"../runtime-api.js"`、`jsonResult` from `"openclaw/plugin-sdk/tool-results"`、`createFeishuToolClient` from `"./tool-account.js"`、`resolveAnyEnabledFeishuToolsConfig` from `"./tool-account.js"`、`listEnabledFeishuAccounts` from `"./accounts.js"`、`toolExecutionErrorResult` from `"./tool-result.js"`、`FeishuSearchSchema` from `"./search-schema.js"`）:

```ts
export function registerFeishuSearchTools(api: OpenClawPluginApi): void {
  if (!api.config) return;
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.search) return;

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_search",
        label: "Feishu Search",
        description:
          "Search Feishu cloud documents and wiki by keyword. Returns matching docs (title, type, url, token). Use when the user asks to find/search feishu docs or wiki content.",
        parameters: FeishuSearchSchema,
        async execute(_toolCallId, params) {
          const p = params as { query: string; limit?: number; accountId?: string };
          try {
            const client = createFeishuToolClient({
              api,
              executeParams: p,
              defaultAccountId,
              requiredTool: { family: "search", label: "Search" },
            });
            return jsonResult(await searchDocs(client, p.query, p.limit ?? 10));
          } catch (err) {
            return toolExecutionErrorResult(err);
          }
        },
      };
    },
    { name: "feishu_search" },
  );
}
```

（`listEnabledFeishuAccounts`/`resolveAnyEnabledFeishuToolsConfig`/`toolExecutionErrorResult` 的确切导出模块名以 wiki.ts/drive.ts 现有 import 为准——照抄它们的 import 行，别自造路径。`registerTool` 第二参 `{ name: "feishu_search" }` 若现有 registerTool 签名不同，照 wiki.ts 的调用形状来。）

`extensions/feishu/api.ts` — 在 `registerFeishuWikiTools` 那行附近加：

```ts
export { registerFeishuSearchTools } from "./src/search.js";
```

`extensions/feishu/index.ts` — 照现有 wrapper 加一个 `registerFeishuSearchTools(api)` 函数（`loadBundledEntryExportSync` + `exportName: "registerFeishuSearchTools"`），并在 `registerFull(api)` 里、`registerFeishuWikiTools(api);` 之后加 `registerFeishuSearchTools(api);`。

`extensions/feishu/openclaw.plugin.json` — `contracts.tools` 数组加 `"feishu_search"`；`toolMetadata` 加：

```json
"feishu_search": {
  "configSignals": [
    { "rootPath": "channels.feishu", "required": ["appId", "appSecret"] },
    { "rootPath": "channels.feishu", "overlayMapPath": "accounts", "required": ["appId", "appSecret"] }
  ]
}
```

- [ ] **Step 4: Run → PASS**（execute 测试 + Task 1 的都过）；跑全包 `node scripts/test-projects.mjs test/vitest/vitest.extension-feishu.config.ts` 确认无回归；`pnpm tsgo` 干净。
- [ ] **Step 5: Commit** — `git commit -am "feat(feishu): register feishu_search tool + plugin manifest wiring"`

---

### Task 4: 端到端冒烟（手动，非自动测试）

- [ ] 冒烟：worktree `pnpm install` + 构建 → `--dev` 网关起来后（配了 feishu app、已加 `search:docs:read` scope），在飞书里私聊机器人"搜一下关于 X 的文档"，确认 agent 调用 `feishu_search` 并返回结果。若飞书报缺 scope，提示 owner 去开放平台加 `search:docs:read` 并发版（本设计里 owner 已完成）。
- [ ] README/文档：在飞书插件已有 tool 文档处补一句 `feishu_search`（若有集中的 tool 列表文档；无则跳过，YAGNI）。

---

## Self-Review

**Spec coverage**：单工具 `feishu_search`(Task3) / 单端点 doc_wiki(Task1 searchDocs) / 统一结果结构(Task1 类型+映射) / 错误处理不吞(Task1 非0抛+Task3 execute包装) / 测试注入假 client(Task1&3) / tools-config gating(Task2) / plugin.json 注册(Task3) / 不动核心(全部 extensions/feishu) ✔。scope 已 owner 完成(spec §7)。

**No-placeholder**：所有代码给全；标注了几处"以现有 import/签名为准"的实测点（TypeBox 导入路径、listEnabledFeishuAccounts 等 import 行、registerTool 第二参形状、api.config 最小形状）——这些是"照抄现有邻居代码"的指令，非占位（实现者读 wiki.ts/drive.ts 即得确切形式）。

**类型一致**：`searchDocs`/`FeishuSearchResult`/`FeishuSearchSchema`(Task1) 被 Task3 一致引用；`search` family(Task2) 被 Task3 的 `requiredTool.family` 与 gating 一致使用。
