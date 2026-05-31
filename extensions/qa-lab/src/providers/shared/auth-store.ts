import path from "node:path";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";

type QaAuthProfileCredential =
  | {
      type: "api_key";
      provider: string;
      key?: string;
      keyRef?: QaSecretRef;
      displayName?: string;
    }
  | {
      type: "token";
      provider: string;
      token?: string;
      tokenRef?: QaSecretRef;
      expires?: number;
    }
  | {
      type: "oauth";
      provider: string;
      access?: string;
      refresh?: string;
      expires?: number;
      idToken?: string;
      clientId?: string;
      enterpriseUrl?: string;
      projectId?: string;
      accountId?: string;
      chatgptPlanType?: string;
      oauthRef?: QaLegacyOAuthRef;
    };

type QaSecretRef = {
  source: "env" | "file" | "exec";
  provider?: string;
  id: string;
};

type QaLegacyOAuthRef = {
  source: "openclaw-credentials";
  provider: "openai";
  id: string;
};

export function resolveQaAgentAuthDir(params: { stateDir: string; agentId: string }): string {
  return path.join(params.stateDir, "agents", params.agentId, "agent");
}

export async function writeQaAuthProfiles(params: {
  agentDir: string;
  stateDir: string;
  profiles: Record<string, QaAuthProfileCredential>;
}): Promise<void> {
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const existing = loadAuthProfileStoreWithoutExternalProfiles(params.agentDir, { env });
  saveAuthProfileStore(
    {
      ...existing,
      profiles: {
        ...existing.profiles,
        ...(params.profiles as AuthProfileStore["profiles"]),
      },
    },
    params.agentDir,
    { env },
  );
}
