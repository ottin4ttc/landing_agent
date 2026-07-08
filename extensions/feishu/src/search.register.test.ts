import { describe, it, expect } from "vitest";
import { resolveOnboardingSearch } from "./search.js";

describe("resolveOnboardingSearch", () => {
  it("未配 seedRefreshToken → 返回 null（走原 tenant 搜索）", () => {
    const account: any = { appId: "a", appSecret: "s", config: { onboardingSearch: {} } };
    expect(resolveOnboardingSearch(account)).toBeNull();
  });

  it("配了 seedRefreshToken → 返回 provider + spaceId", () => {
    const account: any = {
      appId: "a",
      appSecret: "s",
      config: {
        onboardingSearch: {
          seedRefreshToken: "seed",
          refreshTokenStorePath: "/tmp/does-not-write-until-refresh.json",
          spaceId: "7065",
        },
      },
    };
    const r = resolveOnboardingSearch(account);
    expect(r).not.toBeNull();
    // 向后兼容：单个 spaceId 归一化为 spaceIds 列表
    expect(r!.spaceIds).toEqual(["7065"]);
    expect(typeof r!.provider.getUserAccessToken).toBe("function");
  });

  it("配了 spaceIds 列表 → 原样返回多空间", () => {
    const account: any = {
      appId: "a",
      appSecret: "s",
      config: {
        onboardingSearch: {
          seedRefreshToken: "seed",
          spaceIds: ["7065", "7659"],
        },
      },
    };
    const r = resolveOnboardingSearch(account);
    expect(r).not.toBeNull();
    expect(r!.spaceIds).toEqual(["7065", "7659"]);
  });

  it("seedRefreshToken 为 secretRef({source:'env',...}) 且环境变量存在 → 正常解析出 provider", () => {
    process.env.FEISHU_TEST_SEED_REFRESH_TOKEN = "env-seed-value";
    try {
      const account: any = {
        appId: "a",
        appSecret: "s",
        config: {
          onboardingSearch: {
            seedRefreshToken: {
              source: "env",
              provider: "default",
              id: "FEISHU_TEST_SEED_REFRESH_TOKEN",
            },
          },
        },
      };
      const r = resolveOnboardingSearch(account);
      expect(r).not.toBeNull();
      expect(typeof r!.provider.getUserAccessToken).toBe("function");
    } finally {
      delete process.env.FEISHU_TEST_SEED_REFRESH_TOKEN;
    }
  });

  it("seed 缺失（未配置）→ 仍返回 null", () => {
    const account: any = { appId: "a", appSecret: "s", config: {} };
    expect(resolveOnboardingSearch(account)).toBeNull();
  });
});
