import type { Server } from "node:http";
// landingAgent-specific (not upstream openclaw)
import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/store/schema.ts";
import { parseCookies } from "../src/web/cookies.ts";
import { createServer } from "../src/web/server.ts";

let server: Server;
afterEach(() => server?.close());
const base = (cfg: any) => {
  const db = openDb(":memory:");
  server = createServer(db, cfg);
  return new Promise<string>((resolve) => {
    server.listen(0, () => resolve(`http://127.0.0.1:${(server.address() as any).port}`));
  });
};

describe("parseCookies", () => {
  it("parses cookie header", () => {
    expect(parseCookies("dcadmin_sid=abc; x=1")).toEqual({ dcadmin_sid: "abc", x: "1" });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe("routes auth gating", () => {
  const cfg = {
    port: 0,
    feishu: { appId: "a", appSecret: "s", redirectUrl: "u" },
    adminAllowedUsers: ["ou_1"],
    devToken: "dev",
    cookieSecure: false,
  };
  it("api without session -> 401", async () => {
    const url = await base(cfg);
    const r = await fetch(`${url}/qa-admin/api/dashboard`);
    expect(r.status).toBe(401);
  });
  it("page without session -> 302 to login", async () => {
    const url = await base(cfg);
    const r = await fetch(`${url}/qa-admin/dashboard`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/qa-admin/login");
  });
  it("dev backdoor logs in and api returns 200 json", async () => {
    const url = await base(cfg);
    const login = await fetch(`${url}/qa-admin/login?dev=dev`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const r = await fetch(`${url}/qa-admin/api/dashboard`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toHaveProperty("totalSessions");
  });
  it("dev backdoor rejected when devToken wrong", async () => {
    const url = await base(cfg);
    const login = await fetch(`${url}/qa-admin/login?dev=wrong`, { redirect: "manual" });
    expect(login.headers.get("set-cookie")).toBeNull();
  });
  it("oauth callback with non-whitelisted open_id -> 403, no cookie", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes("open.feishu.cn")) {
        if (url.includes("app_access_token")) {
          return new Response(JSON.stringify({ app_access_token: "app-tok" }), { status: 200 });
        }
        if (url.includes("oidc/access_token")) {
          return new Response(JSON.stringify({ data: { access_token: "user-tok" } }), {
            status: 200,
          });
        }
        if (url.includes("user_info")) {
          return new Response(
            JSON.stringify({ data: { open_id: "ou_stranger", name: "陌生人" } }),
            {
              status: 200,
            },
          );
        }
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const url = await base(cfg);
      const r = await fetch(`${url}/qa-admin/auth/callback?code=abc`, { redirect: "manual" });
      expect(r.status).toBe(403);
      expect(r.headers.get("set-cookie")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
