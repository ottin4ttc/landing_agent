import { describe, it, expect } from "vitest";
import { buildAuthorizeUrl, exchangeCodeForOpenId } from "../src/web/feishu-oauth.ts";

const cfg: any = {
  feishu: {
    appId: "cli_x",
    appSecret: "sec",
    redirectUrl: "http://localhost:19010/qa-admin/auth/callback",
  },
};

describe("buildAuthorizeUrl", () => {
  it("includes app_id, redirect_uri, state", () => {
    const u = buildAuthorizeUrl(cfg, "st1");
    expect(u).toContain("app_id=cli_x");
    expect(u).toContain(encodeURIComponent("http://localhost:19010/qa-admin/auth/callback"));
    expect(u).toContain("state=st1");
  });
});

describe("exchangeCodeForOpenId", () => {
  it("parses open_id and name from user_info (dataclaw flow)", async () => {
    // dataclaw feishu-oauth.js: oidc/access_token returns a USER access_token,
    // then user_info returns data.open_id + data.name.
    const http = (async (url: string) => {
      const u = String(url);
      if (u.includes("app_access_token"))
        return { json: async () => ({ app_access_token: "aat" }) } as any;
      if (u.includes("oidc/access_token"))
        return { json: async () => ({ data: { access_token: "uat" } }) } as any;
      // user_info
      return { json: async () => ({ data: { open_id: "ou_1", name: "张三" } }) } as any;
    }) as unknown as typeof fetch;
    const r = await exchangeCodeForOpenId(cfg, "code123", http);
    expect(r).toEqual({ openId: "ou_1", name: "张三" });
  });
});
