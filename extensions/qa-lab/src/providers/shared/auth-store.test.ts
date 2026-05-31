import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "openclaw/plugin-sdk/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { writeQaAuthProfiles } from "./auth-store.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qa-auth-store-"));
  tempDirs.push(dir);
  return dir;
}

function readQaAuthProfiles(agentDir: string): { profiles?: Record<string, unknown> } {
  return loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
    env: { ...process.env, OPENCLAW_STATE_DIR: agentDir },
  });
}

describe("QA auth profile store", () => {
  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("writes a new auth profile store when none exists", async () => {
    const agentDir = await createTempDir();

    await writeQaAuthProfiles({
      agentDir,
      stateDir: agentDir,
      profiles: {
        "qa-mock-openai": {
          type: "api_key",
          provider: "openai",
          key: "qa-mock-not-a-real-key",
        },
      },
    });

    expect(readQaAuthProfiles(agentDir).profiles?.["qa-mock-openai"]).toMatchObject({
      type: "api_key",
      provider: "openai",
    });
  });

  it("leaves corrupt legacy auth profile files untouched", async () => {
    const agentDir = await createTempDir();
    const authPath = path.join(agentDir, "auth-profiles.json");
    await fs.writeFile(authPath, "{not-json", "utf8");

    await writeQaAuthProfiles({
      agentDir,
      stateDir: agentDir,
      profiles: {
        "qa-mock-openai": {
          type: "api_key",
          provider: "openai",
          key: "qa-mock-not-a-real-key",
        },
      },
    });

    await expect(fs.readFile(authPath, "utf8")).resolves.toBe("{not-json");
    expect(readQaAuthProfiles(agentDir).profiles?.["qa-mock-openai"]).toMatchObject({
      type: "api_key",
      provider: "openai",
    });
  });

  it("ignores malformed legacy auth profile shapes", async () => {
    const agentDir = await createTempDir();
    const authPath = path.join(agentDir, "auth-profiles.json");
    const original = JSON.stringify({ version: 1, profiles: { broken: "token" } });
    await fs.writeFile(authPath, original, "utf8");

    await writeQaAuthProfiles({
      agentDir,
      stateDir: agentDir,
      profiles: {
        "qa-mock-openai": {
          type: "api_key",
          provider: "openai",
          key: "qa-mock-not-a-real-key",
        },
      },
    });

    await expect(fs.readFile(authPath, "utf8")).resolves.toBe(original);
    const written = readQaAuthProfiles(agentDir);
    expect(written.profiles?.broken).toBeUndefined();
    expect(written.profiles?.["qa-mock-openai"]).toMatchObject({
      type: "api_key",
      provider: "openai",
    });
  });

  it("preserves existing ref-backed auth profile shapes", async () => {
    const agentDir = await createTempDir();
    const authPath = path.join(agentDir, "auth-profiles.json");
    await fs.writeFile(
      authPath,
      `${JSON.stringify({
        version: 1,
        profiles: {
          existing: {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      })}\n`,
      "utf8",
    );

    await writeQaAuthProfiles({
      agentDir,
      stateDir: agentDir,
      profiles: {
        "qa-mock-anthropic": {
          type: "api_key",
          provider: "anthropic",
          key: "qa-mock-not-a-real-key",
        },
      },
    });

    const written = readQaAuthProfiles(agentDir);
    expect(written.profiles?.existing).toEqual({
      type: "api_key",
      provider: "openai",
      keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    });
    expect(written.profiles?.["qa-mock-anthropic"]).toMatchObject({
      type: "api_key",
      provider: "anthropic",
    });
  });

  it("preserves existing token and oauth auth profile shapes", async () => {
    const agentDir = await createTempDir();
    const authPath = path.join(agentDir, "auth-profiles.json");
    await fs.writeFile(
      authPath,
      `${JSON.stringify({
        version: 1,
        profiles: {
          tokenProfile: {
            type: "token",
            provider: "github",
            token: { source: "file", provider: "vault", id: "github/token" },
          },
          oauthProfile: {
            type: "oauth",
            provider: "chatgpt",
            access: "qa-access-token",
            refresh: "qa-refresh-token",
            expires: 1_900_000_000_000,
          },
          legacyOAuthProfile: {
            type: "oauth",
            provider: "openai",
            expires: 1_900_000_000_000,
            oauthRef: {
              source: "openclaw-credentials",
              provider: "openai",
              id: "0123456789abcdef0123456789abcdef",
            },
          },
        },
      })}\n`,
      "utf8",
    );

    await writeQaAuthProfiles({
      agentDir,
      stateDir: agentDir,
      profiles: {
        "qa-mock-openai": {
          type: "api_key",
          provider: "openai",
          key: "qa-mock-not-a-real-key",
        },
      },
    });

    const written = readQaAuthProfiles(agentDir);
    expect(written.profiles?.tokenProfile).toEqual({
      type: "token",
      provider: "github",
      tokenRef: { source: "file", provider: "vault", id: "github/token" },
    });
    expect(written.profiles?.oauthProfile).toEqual({
      type: "oauth",
      provider: "chatgpt",
      access: "qa-access-token",
      refresh: "qa-refresh-token",
      expires: 1_900_000_000_000,
    });
    expect(written.profiles?.legacyOAuthProfile).toEqual({
      type: "oauth",
      provider: "openai",
      expires: 1_900_000_000_000,
    });
  });

  it("preserves existing providerless secret refs", async () => {
    const agentDir = await createTempDir();
    const authPath = path.join(agentDir, "auth-profiles.json");
    await fs.writeFile(
      authPath,
      `${JSON.stringify({
        version: 1,
        profiles: {
          existing: {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", id: "OPENAI_API_KEY" },
          },
        },
      })}\n`,
      "utf8",
    );

    await writeQaAuthProfiles({
      agentDir,
      stateDir: agentDir,
      profiles: {
        "qa-mock-anthropic": {
          type: "api_key",
          provider: "anthropic",
          key: "qa-mock-not-a-real-key",
        },
      },
    });

    const written = readQaAuthProfiles(agentDir);
    expect(written.profiles?.existing).toEqual({
      type: "api_key",
      provider: "openai",
      keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    });
  });

  it("preserves existing legacy api key alias profiles", async () => {
    const agentDir = await createTempDir();
    const authPath = path.join(agentDir, "auth-profiles.json");
    await fs.writeFile(
      authPath,
      `${JSON.stringify({
        version: 1,
        profiles: {
          existing: {
            mode: "api_key",
            provider: "openai",
            apiKey: "qa-existing-key",
          },
        },
      })}\n`,
      "utf8",
    );

    await writeQaAuthProfiles({
      agentDir,
      stateDir: agentDir,
      profiles: {
        "qa-mock-anthropic": {
          type: "api_key",
          provider: "anthropic",
          key: "qa-mock-not-a-real-key",
        },
      },
    });

    const written = readQaAuthProfiles(agentDir);
    expect(written.profiles?.existing).toEqual({
      type: "api_key",
      provider: "openai",
      key: "qa-existing-key",
    });
  });
});
