// landingAgent-specific (not upstream openclaw)
import { GatewayClient } from "@openclaw/gateway-client";
import type { SessionsUsageResult } from "../../../../src/shared/usage-types.ts";
import type { QaConfig } from "../config.ts";

// `sessions.usage`'s `range` param only accepts fixed presets ("7d" | "30d" | "90d" | "1y" | "all"),
// so an arbitrary `${cfg.usageRangeDays}d` is invalid. Compute an explicit UTC date window instead.
export function usageDateRange(
  nowMs: number,
  days: number,
): { startDate: string; endDate: string } {
  const toYmd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const dayMs = 24 * 60 * 60 * 1000;
  return {
    startDate: toYmd(nowMs - days * dayMs),
    endDate: toYmd(nowMs),
  };
}

export function fetchUsageViaGateway(cfg: QaConfig): Promise<SessionsUsageResult> {
  return new Promise((resolve, reject) => {
    const client = new GatewayClient({
      url: cfg.gatewayUrl,
      // Production gateway uses token auth; dev (auth=none) leaves this undefined.
      token: cfg.gatewayToken ?? undefined,
      clientName: "gateway-client",
      clientVersion: "1.0.0",
      mode: "backend",
      role: "operator",
      scopes: ["operator.read"],
      onHelloOk: () => {
        const { startDate, endDate } = usageDateRange(Date.now(), cfg.usageRangeDays);
        client
          .request("sessions.usage", {
            agentScope: "all",
            startDate,
            endDate,
            mode: "utc",
            limit: 1000,
          })
          .then((usage) => resolve(usage as SessionsUsageResult))
          .catch((e: unknown) => reject(e))
          .finally(() => client.stop());
      },
      onConnectError: (e: Error) => {
        client.stop();
        reject(e);
      },
    });
    client.start();
  });
}
