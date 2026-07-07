# 飞书内容检索 agent 工具（feishu_search）设计

- 日期：2026-07-07
- 分支：`feat/feishu-search`
- 状态：设计已与 owner 逐段确认
- 归属：landingAgent item 3（在官方 `extensions/feishu` 插件内扩展，**不动 openclaw 核心**）

## 1. 目标

让 agent 在对话里被自然语言要求时，检索飞书的**云文档与知识库(wiki)内容**并返回命中结果+链接。触发方式 = agent tool（用户在飞书里说"帮我搜关于 X 的文档/wiki"，agent 自动调用），不是终端 CLI（openclaw 架构下插件无法注册终端子命令，且违反不动核心）。

现状缺口：飞书插件有 14 个工具但**无可用检索**（唯一的 `feishu_wiki` search 是被禁用的占位）。

## 2. 关键取舍（已确认）

- **单聚合工具** `feishu_search`，而非扩多个家族工具 action。
- **单端点** `search/v2/doc_wiki/search`（SDK: `client.search.docWiki.search`）覆盖云文档 + wiki 文档两类，`docs_type` 字段区分类型。
  - 实测：tenant token + scope `search:docs:read` 即可（`code 0 success`）。
  - 不用 `wiki/v1/nodes/search`：它需要 user_access_token，机器人只有 app/tenant token，用不了。
- **不要** `scope: wiki|doc|all` 参数（一个端点返回混合结果，按 `docs_type` 标注即可）→ 工具签名简化。
- 会话级触发，只读检索。

## 3. 工具形态

```
feishu_search({ query: string, limit?: number = 10 })  // limit 上限 50
```

注册在 `extensions/feishu/`：

- `src/search.ts` — 工具注册（`api.registerTool`）+ fan-out/映射逻辑 + 内部搜索函数
- `src/search-schema.ts` — 参数 TypeBox schema
- `openclaw.plugin.json` — `contracts.tools` 加 `feishu_search`；`toolMetadata.feishu_search.configSignals` 复用 appId/appSecret（缺凭证不激活）
- `extensions/feishu/index.ts` — 挂载 `registerFeishuSearchTools`

## 4. 数据流与结果结构

`agent → feishu_search(query,limit) → client.search.docWiki.search({query, page_size:limit}) → 映射 → 统一结果`

飞书响应：`data { has_more, page_token, total, items[] }`；每 item 含 `docs_token`、`docs_type`、`title`、`url`、`owner_id` 等（**确切 item 字段名到实现时对非空结果核实**，属实测项非占位）。

工具返回给 agent 的统一结构：

```
{
  query, total,
  results: [
    { type: docs_type,   // docx/sheet/bitable/wiki/... 原样标注
      title,
      url,               // 可直接打开的飞书链接
      token }            // docs_token
  ]
}
```

- 空结果（total 0）→ `{ total: 0, results: [] }`，让 agent 自然回复"没搜到"。
- 分页：默认取前 `limit`（默认 10、上限 50），不做深翻页（YAGNI）。

## 5. 错误处理（遵循仓库红线：快速失败、不静默吞异常）

- 缺 scope / token 失效 → 飞书返回非 0 `code` → 工具返回**明确错误**（含飞书 `msg`，提示可能要加 scope/发版），不假装成空结果。
- 参数：`query` 必填非空；`limit` 缺省 10、截断到 [1,50]。

## 6. 测试（vitest，注入 fake SDK client，不打真网络）

- 内部函数 `searchDocs(client, query, limit): Promise<SearchResult>`：
  - 注入 fake client 返回样例响应 → 断言映射成统一结构、字段正确、url/token/type 对。
  - 空结果 → `{ total:0, results:[] }`。
  - 飞书非 0 code → 抛/返回明确错误（断言不吞、错误含 msg）。
  - `limit` 截断（>50 → 50，<1 或缺省 → 默认）。
- 工具 `execute` 层：参数校验、调用内部函数、结构透传。

## 7. 权限（owner 侧，已完成）

- app `cli_aac1192ba3759cc0` 已加 scope **`search:docs:read`** 并发版生效（实测 `code 0`）。

## 8. 非目标（YAGNI）

- 聊天消息 im 搜索、云盘文件 drive 搜索、联系人搜索（本期只 doc+wiki）。
- 终端 `openclaw feishu search` 子命令（架构不支持，且违反不动核心）。
- 深翻页 / 复杂过滤 / 跨来源二次排序。
- wiki 节点树搜索（需 user token，不做）。

## 9. 扩展点确认

全部新增在 `extensions/feishu/` 内，openclaw 核心 `src/` 零改动，符合 fork 纪律。
