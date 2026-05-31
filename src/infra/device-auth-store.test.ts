import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  clearDeviceAuthToken,
  loadDeviceAuthStore,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from "./device-auth-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

function createEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  };
}

type DeviceAuthTestDatabase = Pick<OpenClawStateKyselyDatabase, "device_auth_tokens">;

function writeLegacyDeviceAuthStore(stateDir: string, store: unknown): string {
  const filePath = path.join(stateDir, "identity", "device-auth.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(store)}\n`, "utf8");
  return filePath;
}

describe("infra/device-auth-store", () => {
  it("stores and loads device auth tokens under the configured state dir", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      vi.spyOn(Date, "now").mockReturnValue(1234);

      const entry = storeDeviceAuthToken({
        deviceId: "device-1",
        role: " operator ",
        token: "secret",
        scopes: [" operator.write ", "operator.read", "operator.read"],
        env: createEnv(stateDir),
      });

      expect(entry).toEqual({
        token: "secret",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        updatedAtMs: 1234,
      });
      expect(
        loadDeviceAuthToken({
          deviceId: "device-1",
          role: "operator",
          env: createEnv(stateDir),
        }),
      ).toEqual(entry);

      expect(loadDeviceAuthStore({ env: createEnv(stateDir) })).toEqual({
        version: 1,
        deviceId: "device-1",
        tokens: {
          operator: entry,
        },
      });
    });
  });

  it("returns null for missing or mismatched token rows", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();

      const database = openOpenClawStateDatabase({ env });
      const db = getNodeSqliteKysely<DeviceAuthTestDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db.insertInto("device_auth_tokens").values({
          device_id: "device-2",
          role: "operator",
          token: "x",
          scopes_json: "[]",
          updated_at_ms: 1,
        }),
      );
      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();
    });
  });

  it("ignores Android SecurePrefs token markers in shared SQLite auth rows", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);
      const database = openOpenClawStateDatabase({ env });
      const db = getNodeSqliteKysely<DeviceAuthTestDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db.insertInto("device_auth_tokens").values({
          device_id: "device-1",
          role: "operator",
          token: "__openclaw_secure_prefs__",
          scopes_json: "[]",
          updated_at_ms: 1,
        }),
      );

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();
      expect(loadDeviceAuthStore({ env })).toBeNull();
    });
  });

  it("falls back to legacy JSON device auth and seeds SQLite", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);
      writeLegacyDeviceAuthStore(stateDir, {
        version: 1,
        deviceId: "legacy-device",
        tokens: {
          operator: {
            token: "legacy-token",
            role: "operator",
            scopes: ["operator.admin"],
            updatedAtMs: 42,
          },
        },
      });

      expect(loadDeviceAuthToken({ deviceId: "legacy-device", role: "operator", env })).toEqual({
        token: "legacy-token",
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        updatedAtMs: 42,
      });
      expect(loadDeviceAuthStore({ env })?.deviceId).toBe("legacy-device");

      const database = openOpenClawStateDatabase({ env });
      const db = getNodeSqliteKysely<DeviceAuthTestDatabase>(database.db);
      const rows = executeSqliteQuerySync(
        database.db,
        db.selectFrom("device_auth_tokens").selectAll(),
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.token).toBe("legacy-token");
    });
  });

  it("preserves same-device legacy roles before the first SQLite token write", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);
      writeLegacyDeviceAuthStore(stateDir, {
        version: 1,
        deviceId: "legacy-device",
        tokens: {
          operator: {
            token: "old-operator-token",
            role: "operator",
            scopes: ["operator.read"],
            updatedAtMs: 42,
          },
          node: {
            token: "legacy-node-token",
            role: "node",
            scopes: ["node.run"],
            updatedAtMs: 43,
          },
        },
      });

      storeDeviceAuthToken({
        deviceId: "legacy-device",
        role: "operator",
        token: "fresh-operator-token",
        env,
      });

      expect(loadDeviceAuthToken({ deviceId: "legacy-device", role: "operator", env })?.token).toBe(
        "fresh-operator-token",
      );
      expect(loadDeviceAuthToken({ deviceId: "legacy-device", role: "node", env })?.token).toBe(
        "legacy-node-token",
      );
    });
  });

  it("preserves same-device legacy roles before the first SQLite token clear", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);
      writeLegacyDeviceAuthStore(stateDir, {
        version: 1,
        deviceId: "legacy-device",
        tokens: {
          operator: {
            token: "legacy-operator-token",
            role: "operator",
            scopes: ["operator.read"],
            updatedAtMs: 42,
          },
          node: {
            token: "legacy-node-token",
            role: "node",
            scopes: ["node.run"],
            updatedAtMs: 43,
          },
        },
      });

      clearDeviceAuthToken({ deviceId: "legacy-device", role: "operator", env });

      expect(loadDeviceAuthToken({ deviceId: "legacy-device", role: "operator", env })).toBeNull();
      expect(loadDeviceAuthToken({ deviceId: "legacy-device", role: "node", env })?.token).toBe(
        "legacy-node-token",
      );
    });
  });

  it("does not delete mismatched legacy JSON when clearing an empty SQLite store", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);
      const filePath = writeLegacyDeviceAuthStore(stateDir, {
        version: 1,
        deviceId: "legacy-device",
        tokens: {
          operator: {
            token: "legacy-operator-token",
            role: "operator",
            scopes: ["operator.read"],
            updatedAtMs: 42,
          },
        },
      });

      clearDeviceAuthToken({ deviceId: "other-device", role: "operator", env });

      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  it("does not resurrect legacy JSON after clearing the seeded SQLite token", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);
      const filePath = writeLegacyDeviceAuthStore(stateDir, {
        version: 1,
        deviceId: "legacy-device",
        tokens: {
          operator: {
            token: "stale-token",
            role: "operator",
            scopes: ["operator.read"],
            updatedAtMs: 42,
          },
        },
      });

      expect(loadDeviceAuthToken({ deviceId: "legacy-device", role: "operator", env })).toEqual(
        expect.objectContaining({ token: "stale-token" }),
      );
      clearDeviceAuthToken({ deviceId: "legacy-device", role: "operator", env });

      expect(loadDeviceAuthToken({ deviceId: "legacy-device", role: "operator", env })).toBeNull();
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  it("does not re-seed stale legacy JSON after SQLite has current auth rows", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);
      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "current-operator-token",
        env,
      });
      writeLegacyDeviceAuthStore(stateDir, {
        version: 1,
        deviceId: "device-1",
        tokens: {
          admin: {
            token: "stale-admin-token",
            role: "admin",
            scopes: ["operator.admin"],
            updatedAtMs: 1,
          },
        },
      });

      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "fresh-operator-token",
        env,
      });

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "admin", env })).toBeNull();
      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })?.token).toBe(
        "fresh-operator-token",
      );

      const database = openOpenClawStateDatabase({ env });
      const db = getNodeSqliteKysely<DeviceAuthTestDatabase>(database.db);
      const rows = executeSqliteQuerySync(
        database.db,
        db.selectFrom("device_auth_tokens").select(["role", "token"]).orderBy("role", "asc"),
      ).rows.map((row) => ({ role: row.role, token: row.token }));
      expect(rows).toEqual([{ role: "operator", token: "fresh-operator-token" }]);
    });
  });

  it("drops tokens from previous devices when storing a replacement device token", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);

      storeDeviceAuthToken({
        deviceId: "device-2",
        role: "operator",
        token: "device-2-token",
        env,
      });
      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "device-1-token",
        env,
      });

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toMatchObject({
        token: "device-1-token",
      });
      expect(loadDeviceAuthToken({ deviceId: "device-2", role: "operator", env })).toBeNull();
    });
  });

  it("clears only the requested role and leaves unrelated tokens intact", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);

      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "operator-token",
        env,
      });
      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "node",
        token: "node-token",
        env,
      });

      clearDeviceAuthToken({
        deviceId: "device-1",
        role: " operator ",
        env,
      });

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();
      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "node", env })?.token).toBe(
        "node-token",
      );
    });
  });

  it("updates retained token rows while pruning removed roles", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);

      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "operator-token",
        env,
      });
      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "node",
        token: "node-token",
        env,
      });

      clearDeviceAuthToken({
        deviceId: "device-1",
        role: "node",
        env,
      });
      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "operator-token-2",
        env,
      });

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "node", env })).toBeNull();
      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toMatchObject({
        token: "operator-token-2",
      });
    });
  });
});
