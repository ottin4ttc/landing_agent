// landingAgent-specific (not upstream openclaw)
import type { QaConfig } from "../config.ts";

// Endpoints mirror the dataclaw production flow
// (dataclaw-service/src/services/feishu-oauth.js, unrolled from @larksuiteoapi/node-sdk):
//   1. app_access_token  (SDK manages this internally; here fetched explicitly)
//   2. oidc/access_token → data.access_token  (the *user* access_token, NOT open_id)
//   3. user_info         → data.open_id + data.name
const AUTH = "https://open.feishu.cn/open-apis/authen/v1/authorize";
const APP_TOKEN = "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal";
const OIDC_TOKEN = "https://open.feishu.cn/open-apis/authen/v1/oidc/access_token";
const USER_INFO = "https://open.feishu.cn/open-apis/authen/v1/user_info";

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
  // 1. app_access_token (body { app_id, app_secret } → app_access_token)
  const appRes = await http(APP_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: cfg.feishu.appId, app_secret: cfg.feishu.appSecret }),
  });
  const appJson = (await appRes.json()) as any;
  const appToken = appJson.app_access_token as string;

  // 2. code → user access_token (Bearer app_access_token, body { grant_type, code })
  //    dataclaw: client.authen.oidcAccessToken.create → data.access_token
  const oidcRes = await http(OIDC_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${appToken}` },
    body: JSON.stringify({ grant_type: "authorization_code", code }),
  });
  const oidcJson = (await oidcRes.json()) as any;
  const userToken = (oidcJson.data ?? oidcJson).access_token as string;

  // 3. user access_token → user info (Bearer user_access_token → data.open_id / data.name)
  //    dataclaw: client.authen.userInfo.get(..., withUserAccessToken)
  const infoRes = await http(USER_INFO, {
    method: "GET",
    headers: { Authorization: `Bearer ${userToken}` },
  });
  const infoJson = (await infoRes.json()) as any;
  const data = infoJson.data ?? infoJson;
  return { openId: data.open_id as string, name: (data.name as string) ?? null };
}
