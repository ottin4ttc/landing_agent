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
