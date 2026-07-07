// landingAgent-specific (not upstream openclaw)
import { GatewayClient } from "@openclaw/gateway-client";
import type { SessionsUsageResult } from "../../../../src/shared/usage-types.ts";
import type { QaConfig } from "../config.ts";

export function fetchUsageViaGateway(cfg: QaConfig): Promise<SessionsUsageResult> {
  return new Promise((resolve, reject) => {
    const client = new GatewayClient({
      url: cfg.gatewayUrl,
      clientName: "gateway-client",
      clientVersion: "1.0.0",
      mode: "backend",
      role: "operator",
      scopes: ["operator.read"],
      onHelloOk: () => {
        client
          .request("sessions.usage", {
            agentScope: "all",
            range: `${cfg.usageRangeDays}d`,
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
