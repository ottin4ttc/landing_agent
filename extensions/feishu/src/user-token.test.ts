import { describe, it, expect, vi } from "vitest";
import {
  createFeishuUserTokenProvider,
  FeishuUserTokenError,
  type RefreshTokenStore,
} from "./user-token.js";

function memStore(initial: string | null = null): RefreshTokenStore {
  let v = initial;
  return {
    read: () => v,
    write: (t) => {
      v = t;
    },
  };
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
      appId: "a",
      appSecret: "s",
      seedRefreshToken: "seed",
      store,
      now: () => 1000,
      fetchImpl,
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
      appId: "a",
      appSecret: "s",
      seedRefreshToken: "seed",
      store,
      now: () => t,
      fetchImpl,
      refreshSkewMs: 300_000,
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
      appId: "a",
      appSecret: "s",
      seedRefreshToken: "seed",
      store,
      now: () => t,
      fetchImpl,
      refreshSkewMs: 300_000,
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
        url.includes("app_access_token") ? appTok : { code: 20037, msg: "refresh token expired" },
    })) as unknown as typeof fetch;
    const p = createFeishuUserTokenProvider({
      appId: "a",
      appSecret: "s",
      seedRefreshToken: "seed",
      store,
      now: () => 1,
      fetchImpl,
    });
    await expect(p.getUserAccessToken()).rejects.toBeInstanceOf(FeishuUserTokenError);
    await expect(p.getUserAccessToken()).rejects.toThrow(/重新.*授权|re-authorize/i);
  });

  it("并发调用只刷新一次", async () => {
    const store = memStore(null);
    const { fetchImpl, calls } = makeFetch([appTok, refreshed(1)]);
    const p = createFeishuUserTokenProvider({
      appId: "a",
      appSecret: "s",
      seedRefreshToken: "seed",
      store,
      now: () => 1,
      fetchImpl,
    });
    const [x, y] = await Promise.all([p.getUserAccessToken(), p.getUserAccessToken()]);
    expect(x).toBe("acc-1");
    expect(y).toBe("acc-1");
    // 只有一轮 app_access_token + 一轮 refresh = 2 次请求
    expect(calls.length).toBe(2);
  });
});
