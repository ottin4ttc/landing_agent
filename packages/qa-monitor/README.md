# @openclaw/qa-monitor

landingAgent-specific admin dashboard: polls the gateway's `sessions.usage` RPC, stores
session rows in SQLite, and serves a Feishu-SSO-gated dashboard (DAU/WAU, top users,
chat-type breakdown) at `/qa-admin/dashboard`.

Not upstream openclaw — lives entirely in `packages/qa-monitor/`.

## Environment variables

| Var                      | Required      | Default                | Description                                                                                                                                                                                 |
| ------------------------ | ------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QA_GATEWAY_URL`         | no            | `ws://127.0.0.1:19001` | Gateway websocket URL the collector connects to.                                                                                                                                            |
| `QA_FEISHU_APP_ID`       | yes (for SSO) | `""`                   | Feishu app id used for the OAuth login flow.                                                                                                                                                |
| `QA_FEISHU_APP_SECRET`   | yes (for SSO) | `""`                   | Feishu app secret.                                                                                                                                                                          |
| `QA_FEISHU_REDIRECT_URL` | yes (for SSO) | `""`                   | OAuth redirect URL registered in the Feishu console.                                                                                                                                        |
| `QA_ADMIN_ALLOWED_USERS` | yes           | `""`                   | Comma-separated Feishu `open_id`s allowed into the dashboard (fail-closed whitelist).                                                                                                       |
| `QA_PORT`                | no            | `19010`                | HTTP port the dashboard server listens on.                                                                                                                                                  |
| `QA_POLL_INTERVAL_MS`    | no            | `180000`               | Interval between collector polls of `sessions.usage`.                                                                                                                                       |
| `QA_DEV_TOKEN`           | no            | `null`                 | If set, enables `/qa-admin/login?dev=<token>` as a dev-only bypass of Feishu SSO. Do not set in production.                                                                                 |
| `QA_DB_PATH`             | no            | `./qa.db`              | SQLite database file path.                                                                                                                                                                  |
| `QA_COOKIE_SECURE`       | no            | `false`                | Set to `"true"` to mark the session cookie `Secure` (requires HTTPS).                                                                                                                       |
| `QA_USAGE_RANGE_DAYS`    | no            | `30`                   | Number of trailing days of usage the collector requests per poll (converted to an explicit UTC `startDate`/`endDate` window, since the gateway's `range` param only accepts fixed presets). |

## Start

```bash
QA_FEISHU_APP_ID=cli_xxx \
QA_FEISHU_APP_SECRET=xxx \
QA_FEISHU_REDIRECT_URL=http://localhost:19010/qa-admin/auth/callback \
QA_ADMIN_ALLOWED_USERS=ou_xxx,ou_yyy \
pnpm --filter @openclaw/qa-monitor start
```

Then open `http://localhost:19010/qa-admin/login` (or, for local dev without Feishu,
`http://localhost:19010/qa-admin/login?dev=<QA_DEV_TOKEN>`).

## Owner TODO

Add the following redirect URL to the Feishu app console (App Info → Security Settings →
Redirect URL) before SSO login will work end-to-end:

```
http://localhost:19010/qa-admin/auth/callback
```
