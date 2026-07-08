# 飞书 Onboarding 知识检索改造 · 设计（spec）

> landingAgent 专属改造（非 upstream openclaw）。目标：新人问概念/制度时，机器人能**搜到**公司企业公开 wiki 知识库 → **读**正文 → 用真实内容作答。

## 背景与约束（为何必须 user_access_token）

公司 onboarding 知识在飞书「TTC 制度汇」知识库（**企业公开** wiki，`space_id=7065297004640878595`，含 Offer/Billing/入职/报销等制度）。穷尽验证后确认：**应用（tenant）身份无法搜索这些内容**，只能用 **user_access_token**。实测结论：

| 尝试 | 结果 |
| --- | --- |
| `wiki/v2/spaces/{id}/members` 加应用成员 | `131101 public wiki space can't create member`（企业公开库禁用成员，管理员亦不可） |
| `spaces/{id}/nodes` / `get_space`（tenant） | `131006 tenant needs read permission` |
| `wiki/v1/nodes/search`、`drive/v1/files/search`（tenant） | `99991663` 只认 user token |
| `suite/docs-api/search/object`（tenant 可调） | `total:0`（应用身份无个人文档索引） |
| `search/v2/doc_wiki`（机器人现用，tenant） | 对 wiki 内容返回 0 |
| **user_access_token + `wiki/v1/nodes/search`** | ✅ 返 20 条命中 |
| **`doc/v2/{obj_token}/raw_content`** 读 billing 正文 | ✅ 读到真实内容 |

**结论**：搜索是「用户身份」范围能力；采用**专用飞书账号**的 user_access_token。

## 全局约束（Global Constraints）

- 代码集中在 `extensions/feishu/`，不动 openclaw 核心 `src/`（fork 克制）。
- 密钥（seed refresh_token、appSecret）**只进环境变量**，经 secretRef `{source:"env"}` 引用，**不写进 config 文件明文**。
- Node ≥ 22.19；TypeScript ESM；vitest；oxlint/oxfmt；pre-commit hooks 真实，**禁止 `--no-verify`**。
- 飞书 API base：`https://open.feishu.cn`。
- 飞书 refresh_token 有效期 30 天、每次刷新返新的；access_token ~2h。
- appId：`cli_aac1192ba3759cc0`。

## 架构：4 个单元

### 单元 1：`extensions/feishu/src/user-token.ts` — FeishuUserTokenProvider

核心新抽象。deep（接口窄）+ leaf（无人依赖其内部状态）。

**接口**：
```ts
export interface FeishuUserTokenProvider {
  getUserAccessToken(): Promise<string>;
}
export function createFeishuUserTokenProvider(deps: {
  appId: string;
  appSecret: string;
  seedRefreshToken: string;         // 首次种子（来自 env）
  store: RefreshTokenStore;         // 落盘读写（单元 4 提供实现，测试注入内存实现）
  now?: () => number;               // 注入时钟，便于测试过期逻辑
  fetchImpl?: typeof fetch;         // 注入 HTTP，便于测试
  refreshSkewMs?: number;           // 提前刷新窗口，默认 300_000（5min）
}): FeishuUserTokenProvider;
```

**RefreshTokenStore 接口**（注入，便于测试）：
```ts
export interface RefreshTokenStore {
  read(): string | null;   // 读盘上的 refresh_token；无则 null
  write(token: string): void;
}
```

**行为**：
1. 内存持 `{ accessToken, expiresAtMs }`，初始为空。
2. `getUserAccessToken()`：若 `accessToken` 存在且 `now() < expiresAtMs - refreshSkewMs` → 直接返回。
3. 否则刷新：
   - 取当前 refresh_token = `store.read() ?? seedRefreshToken`。
   - 取 app_access_token：`POST /open-apis/auth/v3/app_access_token/internal`（body `{app_id, app_secret}`）。
   - 刷新：`POST /open-apis/authen/v1/oidc/refresh_access_token`，Header `Authorization: Bearer <app_access_token>`，body `{grant_type:"refresh_token", refresh_token}`。
   - 成功（code 0）：从 `data` 取 `access_token`、`refresh_token`、`expires_in`（秒）。`store.write(new refresh_token)`，内存存 `{accessToken, expiresAtMs: now() + expires_in*1000}`，返回 access_token。
   - 失败：抛 `FeishuUserTokenError`（含飞书 code/msg），message 明确提示「服务账号 refresh_token 失效，需重新 OAuth 授权（见 runbook）」。不静默吞。
4. 并发去重：同一时刻多次调用只发一次刷新（用一个 in-flight Promise 缓存）。

### 单元 2：`search.ts` — searchDocs 改为 wiki 节点搜索

替换现有 `client.search.docWiki.search`（SDK/tenant）为 raw HTTP `wiki/v1/nodes/search` + user token。

```ts
export async function searchWikiNodes(deps: {
  getUserAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  spaceId?: string;   // 可选：限定知识库
}, query: string, limit: number): Promise<FeishuSearchResult>;
```

- 请求：`POST /open-apis/wiki/v1/nodes/search`，Header `Authorization: Bearer <user_token>`，body `{query, space_id?}`（space_id 有配置才带）。分页只取前 `limit` 条。
- 响应映射到现有 `FeishuSearchResult`（复用 `search.ts` 已有类型）：每条 → `{ type: obj_type, title, url, token: node_token, ... }`，并携带 `obj_token`、`obj_type`（读取器需要）。
- `FeishuSearchResultItem` 增补可选字段 `objToken?: string`、`objType?: string`。
- 保留 `stripHighlight`、`clampLimit`（`DEFAULT_LIMIT=10, MAX=50`）。

### 单元 3：`onboarding-doc-read.ts` — 按类型读正文

```ts
export async function readWikiDocContent(deps: {
  getUserAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}, objToken: string, objType: string): Promise<string>;
```

- `objType === "docx"` → `GET /open-apis/docx/v1/documents/{objToken}/raw_content`。
- `objType === "doc"`（老版，doccn 前缀）→ `GET /open-apis/doc/v2/{objToken}/raw_content`。
- 其它类型 → 抛错「暂不支持读取该类型：{objType}」。
- 都用 user token；返回 `data.content` 字符串。

### 单元 4：配置与接线

- **config-schema**：`channels.feishu.accounts[].onboardingSearch`（或账号级 `userToken`）新增：
  - `seedRefreshToken`（secretRef → env，**必填才启用**）
  - `refreshTokenStorePath`（默认 `~/.openclaw/feishu-user-token.json`，容器内即 `/root/.openclaw/feishu-user-token.json`）
  - `spaceId`（可选，默认整租户 wiki 搜索）
- **RefreshTokenStore 文件实现**：`file-refresh-store.ts`，读写 JSON `{refresh_token, updated_at}`，写用原子替换（写临时文件 + rename），文件权限 `0600`。
- **`registerFeishuSearchTools`**：当账号配置了 `seedRefreshToken` 时，构造 provider + file store，`feishu_search.execute` 改调 `searchWikiNodes`；`feishu_doc`（或 onboarding 读取路径）用单元 3。未配置时保持原 tenant 行为（不破坏其它用法）。
- app_access_token / appSecret 从账号既有凭证解析（复用 `accounts.ts`）。

## 一次性引导（runbook）

`docs/feishu-service-account-bootstrap.md`：
1. 建**专用飞书账号**（企业成员，企业公开库天然可读）。
2. 用该账号走一次 OAuth 授权（app 需开通**用户身份** scope：`wiki:wiki:readonly`、`docx:document:readonly`，以及读老版 `doc` 所需 scope——具体 scope 名以开发者后台实际可选项为准，bootstrap 时按接口 `99991672` 报错提示逐个补齐并重新发布），拿 `authorization_code`。
3. 跑脚本 `scripts/feishu-exchange-refresh.mjs`（appId/appSecret + code → refresh_token）。
4. 把 refresh_token 写进 BCC `.env` 的 `FEISHU_ONBOARDING_REFRESH_TOKEN`，重启 gateway。
5. 之后自动滚动续期；30 天以上无活动才需重跑本流程。

## 数据流

提问 → `feishu_search`（user token / `wiki/v1/nodes/search`）→ 命中（含 obj_token/obj_type）→ `feishu_doc` 读取（user token / 按类型）→ 正文 → 机器人作答；搜不到如实说不编造（已在 persona 里约束）。

## 错误处理

- refresh 失败 / refresh_token 过期 → `FeishuUserTokenError`，提示重跑引导；工具层经现有 `toolExecutionErrorResult` 返回给 agent。
- 搜索/读取 HTTP 非 0 → 抛含飞书 code/msg 的错误。
- 落盘失败 → 记录并降级为「内存持有本次刷到的 refresh_token」，不中断当次请求（重启后回退到 env 种子）。

## 测试策略（TDD）

- **user-token.ts**：注入 fetchImpl + now + 内存 store。用例：首次用 seed 刷新并落盘；access 未过期直接返回不刷新；过期触发刷新；刷新滚动更新 store；刷新失败抛带提示错误；并发去重只刷一次。
- **search.ts**：mock `wiki/v1/nodes/search` 响应 → 断言映射（title/url/node_token/obj_token/obj_type、limit 截断、highlight 剥除）。
- **onboarding-doc-read.ts**：docx 走 docx/v1、doc 走 doc/v2、未知类型抛错。
- **file-refresh-store.ts**：写后能读回；原子替换；权限。
- 沿用现有 vitest 与 `test-support` mock 约定。

## 术语沉淀

新增领域概念：**服务账号（service account）** = 专用于 onboarding 检索的飞书用户身份，其 user_access_token 供机器人调 wiki 搜索/文档读取。提 PR 前登记进项目 ubiquitous language 文档（docs/ 或 taxonomy.yaml）。

## 非目标（YAGNI）

- 不做多服务账号轮换 / 负载均衡。
- 不做 wiki 内容本地缓存/索引（onboarding 库规模小，实时搜即可）。
- 不改 qa-monitor（独立服务，零影响）。
- 不镜像文档到自建库。
