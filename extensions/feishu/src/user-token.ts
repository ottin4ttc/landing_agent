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
