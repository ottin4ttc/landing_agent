// landingAgent-specific (not upstream openclaw)
export type QaConfig = {
  gatewayUrl: string;
  gatewayToken: string | null;
  port: number;
  dbPath: string;
  pollIntervalMs: number;
  feishu: { appId: string; appSecret: string; redirectUrl: string };
  adminAllowedUsers: string[];
  devToken: string | null;
  cookieSecure: boolean;
  usageRangeDays: number;
};

export function loadConfig(env: NodeJS.ProcessEnv): QaConfig {
  const csv = (v: string | undefined) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    gatewayUrl: env.QA_GATEWAY_URL ?? "ws://127.0.0.1:19001",
    gatewayToken: env.QA_GATEWAY_TOKEN ? env.QA_GATEWAY_TOKEN : null,
    port: Number(env.QA_PORT ?? 19010),
    dbPath: env.QA_DB_PATH ?? "./qa.db",
    pollIntervalMs: Number(env.QA_POLL_INTERVAL_MS ?? 180000),
    feishu: {
      appId: env.QA_FEISHU_APP_ID ?? "",
      appSecret: env.QA_FEISHU_APP_SECRET ?? "",
      redirectUrl: env.QA_FEISHU_REDIRECT_URL ?? "",
    },
    adminAllowedUsers: csv(env.QA_ADMIN_ALLOWED_USERS),
    devToken: env.QA_DEV_TOKEN ? env.QA_DEV_TOKEN : null,
    cookieSecure: env.QA_COOKIE_SECURE === "true",
    usageRangeDays: Number(env.QA_USAGE_RANGE_DAYS ?? 30),
  };
}
