import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("parses env with defaults", () => {
    const cfg = loadConfig({
      QA_FEISHU_APP_ID: "a",
      QA_FEISHU_APP_SECRET: "s",
      QA_FEISHU_REDIRECT_URL: "http://x/cb",
    } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(19010);
    expect(cfg.gatewayUrl).toBe("ws://127.0.0.1:19001");
    expect(cfg.adminAllowedUsers).toEqual([]);
    expect(cfg.cookieSecure).toBe(false);
    expect(cfg.feishu.appId).toBe("a");
    expect(cfg.gatewayToken).toBeNull();
  });
  it("parses allowed users csv and dev token", () => {
    const cfg = loadConfig({
      QA_FEISHU_APP_ID: "a",
      QA_FEISHU_APP_SECRET: "s",
      QA_FEISHU_REDIRECT_URL: "u",
      QA_ADMIN_ALLOWED_USERS: "ou_1, ou_2 ",
      QA_DEV_TOKEN: "dev",
      QA_COOKIE_SECURE: "true",
      QA_PORT: "20000",
      QA_GATEWAY_TOKEN: "gwtok",
    } as NodeJS.ProcessEnv);
    expect(cfg.adminAllowedUsers).toEqual(["ou_1", "ou_2"]);
    expect(cfg.devToken).toBe("dev");
    expect(cfg.gatewayToken).toBe("gwtok");
    expect(cfg.cookieSecure).toBe(true);
    expect(cfg.port).toBe(20000);
  });
});
