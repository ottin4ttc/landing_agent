# QA 监控平台（qa-monitor）设计

- 日期：2026-07-06
- 分支：`feat/qa-monitor`
- 状态：设计已与 owner 逐段确认
- 归属：**landingAgent 特有功能**，非 openclaw upstream（不侵入核心 `src/`）

## 1. 背景与目标

在 landingAgent（openclaw 魔改分支）里做一个 **QA 监控平台**，对 landingAgent 这个 agent（当前经飞书 channel、模型 zenmux `anthropic/claude-opus-4.7`）的对话运营数据做统计和可视化，只有管理员能登录。

需求（owner 原话归纳）：

1. 按人 / 群聊统计对话内容、token 消耗、耗时
2. 会话总数、总消息数、活跃用户数（参考 dataclaw 的 dashboard）
3. 权限管控：只有管理员能登录
4. 参考实现：dataclaw dashboard（`http://120.48.31.69:18789/dc-admin/dashboard`，代码 `/Users/yb/dataclaw`）

已确认的关键取舍：

- **管理员模型**：飞书 SSO OAuth 登录 + 管理员 openId 白名单（多管理员、可审计）。
- **部署**：现在本地跑，按"能上云"解耦设计；监控对象是 landingAgent（含飞书及以后其它 channel）。
- **统计粒度**：会话 / 私聊用户级（**不做**群聊内逐个发言人细分）。
- **架构**：独立 package，定时拉 openclaw 现成网关 RPC，自己 SQLite，飞书 SSO dashboard；**openclaw 核心零改动**。

## 2. 架构与数据流

新 package：`packages/qa-monitor`（包名 `@openclaw/qa-monitor`，文件头注释标记为 landingAgent 特有）。独立进程、自带 HTTP 服务（dev 端口 `19010`）。

三个 deep-leaf 组件，各自单一职责、窄接口：

1. **Collector（采集器）** — 定时（`QA_POLL_INTERVAL`，默认 2–5 分钟）以 operator 客户端连 openclaw 网关（dev：`ws://127.0.0.1:19001`，auth=none），调 `sessions.usage`（+ `usage.cost`，`agentScope:"all"`）拿**每会话行**与聚合，幂等 upsert 进 SQLite。
2. **Store（存储）** — 本地 SQLite（node 内置 `node:sqlite` / `DatabaseSync`，无需装原生模块），`qa_sessions` 快照表 + `qa_admin_sessions` 登录会话表；聚合查询 `aggregate(filters)`。
3. **Web（dashboard + 鉴权）** — 飞书 SSO OAuth + 白名单 → 服务端单页 HTML dashboard + JSON API。

数据流：

```
openclaw 网关 sessions.usage ──(Collector 定时拉)──▶ qa.db(qa_sessions)
                                                      │
                              aggregate(filters) ◀────┘
                                      │
                                      ▼
                         /qa-admin/api/dashboard (JSON)
                                      │
                         /qa-admin/dashboard (HTML 渲染)
```

登录流：`浏览器 → 飞书授权 → 回调校验 openId ∈ 白名单 → 建 session cookie`。

已知约束：飞书 SSO 要在开放平台配**重定向 URL**（本地 `http://localhost:19010/qa-admin/auth/callback`，上云换正式域名）。

## 3. 数据模型与指标

### 3.1 表 `qa_sessions`（每会话一行快照，Collector 幂等 upsert by `session_key`）

| 字段                                                                   | 说明                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------- |
| session_key / session_id                                               | openclaw 会话标识（upsert 主键 session_key）             |
| user_id / user_name                                                    | 发信人：飞书 openId + 姓名（origin.from + contact 解析） |
| channel / chat_type / group_id                                         | 渠道、私聊/群聊、群 id                                   |
| model / provider                                                       | 模型 / 供应商                                            |
| input_tokens / output_tokens / total_tokens / cache_read / cache_write | token 拆分                                               |
| cost_usd                                                               | 成本                                                     |
| message_count / user_msgs / assistant_msgs / tool_calls / error_count  | 消息数拆分                                               |
| avg_latency_ms / p95_latency_ms                                        | 耗时                                                     |
| started_at / last_interaction_at / updated_at                          | 时间戳（存 epoch ms）                                    |

### 3.2 KPI 指标口径（借用 dataclaw 已验证做法）

- **会话总数** = 窗口内 count
- **总消息数** = Σ message_count
- **活跃用户数 / DAU / WAU** = distinct user_id，**按北京日历日窗口**（DAU=末日；WAU=末 7 个日历日）。所有按天/窗口以北京零点为锚（`+8 hours` 偏移），避免 UTC 切天错位。
- **token 消耗** = Σ total_tokens（含 input/output/cache 拆分）+ Σ cost
- **耗时** = avg / p95 latency
- **按人** = GROUP BY user_id 排行（topUsers）
- **按群聊 / 会话类型** = GROUP BY group_id / chat_type
- **成功率** = 1 − error 占比（openclaw 提供 error 计数则算，否则该卡暂不展示）

口径原则：分母缺失时显示「—」，不除零、不拿 0 冒充。

### 3.3 筛选维度

日期 from/to、user、chat_type（全部/私聊/群聊）、渠道。

## 4. 鉴权：飞书 SSO + 管理员白名单

流程（照搬 dataclaw `admin.js` 成熟做法）：

1. 未登录访问 `/qa-admin/*` → 302 跳飞书授权页（用 landingAgent 飞书 app `cli_aac1192ba3759cc0` 的 app_id + 重定向 URL）
2. 飞书回调 `/qa-admin/auth/callback?code=...`
3. 服务端用 code 换 user_access_token → 拿登录者 openId
4. **白名单 fail-closed**：openId ∈ `QA_ADMIN_ALLOWED_USERS` 才放行；**名单为空 = 拒绝所有**；不在名单 → 403
5. 建 session：`randomBytes(24)` 做 sid，存 SQLite `qa_admin_sessions`（TTL 24h），下发 **HttpOnly + SameSite=Lax** cookie（Secure 由环境开关：本地 false / 上云 true）
6. `requireAuth` 中间件：API 未登录 → `401 {ok:false}`；页面 → 302 跳登录并透传原路径（仅允许 `/qa-admin` 前缀，防 open-redirect）

细节：

- 复用 landingAgent 飞书 app（已有 `contact:user.base:readonly`）。需在飞书控制台加重定向 URL。
- 白名单先放 owner 自己：`ou_2cd81c53ea8a2deb28cd2afd72421c8f`。
- Session 存 SQLite（不引 Redis，减部署件）。
- **dev 后门**：本地无飞书回调时，可用 `QA_DEV_TOKEN`（env）直登方便调试 dashboard；**仅 dev 启用**，正式/上云只走飞书 SSO。

## 5. Dashboard 页面

服务端渲染单页 HTML + 原生 JS + 内联 SVG（照搬 dataclaw，不引前端框架；与 openclaw 的 Lit 前端彻底解耦，上云即静态页 + JSON 接口）。

- `GET /qa-admin/dashboard` → HTML
- `GET /qa-admin/api/dashboard?from&to&user&chatType&channel` → JSON

页面结构：

1. 顶栏：标题「landingAgent QA 监控」+ "仅管理员" + 当前登录人 + 登出
2. 筛选条：日期 from/to、用户、会话类型、渠道
3. KPI 卡片行：会话总数、总消息数、活跃用户数、DAU、WAU、token 总消耗（+成本）、平均延迟、P95 延迟
4. 图表区：每日趋势折线（会话数 / token）、按人排行表格、按群聊/会话类型条形、token 构成（input/output/cache）条形、最慢 N 次会话表格
5. 全部文本 `esc()` 防 XSS

视觉：v1 对齐 dataclaw 朴素浅色看板（快速上线、口径一致）。后续如需更强设计感，再单独用 dataviz/frontend 技能升级。

## 6. Package 结构、测试、上云

### 6.1 结构

```
packages/qa-monitor/
  src/
    index.ts            # 入口：起 HTTP 服务 + Collector 定时器
    collector/          # 连网关、拉 sessions.usage、幂等 upsert
    store/              # SQLite schema + aggregate() 聚合查询
    web/                # dashboard html / api / 飞书 OAuth+callback / requireAuth / session
    config.ts           # env 读取
  test/
  package.json
```

### 6.2 配置（env）

`QA_GATEWAY_URL`、`QA_GATEWAY_TOKEN`、`QA_FEISHU_APP_ID`、`QA_FEISHU_APP_SECRET`、`QA_FEISHU_REDIRECT_URL`、`QA_ADMIN_ALLOWED_USERS`（逗号分隔 openId）、`QA_PORT`（默认 19010）、`QA_POLL_INTERVAL`、`QA_DEV_TOKEN`（dev 后门，可空）、`QA_DB_PATH`、`QA_COOKIE_SECURE`。

### 6.3 测试（superpowers TDD，先写测试）

- `store`：aggregate() 各指标 SQL（DAU/WAU 去重、北京日窗口、topUsers、byChatType），参考 dataclaw 用例
- `web`：白名单 fail-closed（空名单拒所有、不在名单 403）、requireAuth 未登录 401/302、open-redirect 防护
- `collector`：upsert 幂等（同 session_key 不双计）
- 本地校验：`pnpm --filter @openclaw/qa-monitor test` + `pnpm tsgo` + `pnpm lint`

### 6.4 运行

dev 指向 `--dev` 网关（`ws://127.0.0.1:19001`，auth=none）：`pnpm --filter @openclaw/qa-monitor start`。

### 6.5 上云路径（本期只设计不实现）

Docker 化；SQLite 挂卷（或后续换阿里云 supabase/Postgres）；cookie Secure=true；正式重定向 URL；Redis 可选。

## 7. 非目标（YAGNI）

- 群聊内逐个发言人细分（本期粒度到会话/私聊用户级）
- 多用户角色/权限分级（本期只有"管理员白名单"单一角色）
- 秒级实时（定时拉快照即可）
- v1 不追求设计感，先"对、全、能用"

## 8. 待办依赖（owner 侧）

- 在飞书开放平台给 app `cli_aac1192ba3759cc0` 的「安全设置」加重定向 URL（本地 `http://localhost:19010/qa-admin/auth/callback`）。
- 上云时提供正式域名与 DB 目标。
