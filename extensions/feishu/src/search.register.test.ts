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
    expect(r!.spaceId).toBe("7065");
    expect(typeof r!.provider.getUserAccessToken).toBe("function");
  });
});
