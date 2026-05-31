import { createHash } from "node:crypto";
import path from "node:path";
import type { Insertable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

type ModelsConfigDatabase = Pick<OpenClawStateKyselyDatabase, "agent_model_catalogs">;
type AgentModelCatalogInsert = Insertable<ModelsConfigDatabase["agent_model_catalogs"]>;

type StoredModelsConfigValue = {
  agentDir: string;
  relativePath: string;
  raw: string;
};

function normalizeCatalogRelativePath(relativePath?: string): string {
  return relativePath?.trim() ?? "";
}

function modelsConfigKey(agentDir: string, relativePath?: string): string {
  const normalizedRelativePath = normalizeCatalogRelativePath(relativePath);
  const keyInput = normalizedRelativePath
    ? `${path.resolve(agentDir)}\0${normalizedRelativePath}`
    : path.resolve(agentDir);
  return createHash("sha256").update(keyInput).digest("hex");
}

function modelsConfigToRow(
  agentDir: string,
  raw: string,
  updatedAt: number,
  relativePath?: string,
): AgentModelCatalogInsert {
  const normalizedRelativePath = normalizeCatalogRelativePath(relativePath);
  return {
    catalog_key: modelsConfigKey(agentDir, normalizedRelativePath),
    agent_dir: path.resolve(agentDir),
    relative_path: normalizedRelativePath,
    raw_json: raw,
    updated_at: updatedAt,
  };
}

function rowToStoredModelsConfigValue(row: {
  agent_dir: string;
  relative_path?: string | null;
  raw_json: string;
}): StoredModelsConfigValue {
  return {
    agentDir: row.agent_dir,
    relativePath: normalizeCatalogRelativePath(row.relative_path ?? undefined),
    raw: row.raw_json,
  };
}

export function readStoredModelsConfigRaw(
  agentDir: string,
  options: OpenClawStateDatabaseOptions = {},
  relativePath?: string,
): { raw: string; updatedAt: number } | undefined {
  const database = openOpenClawStateDatabase(options);
  const db = getNodeSqliteKysely<ModelsConfigDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("agent_model_catalogs")
      .select(["agent_dir", "relative_path", "raw_json", "updated_at"])
      .where("catalog_key", "=", modelsConfigKey(agentDir, relativePath)),
  );
  if (!row) {
    return undefined;
  }
  const value = rowToStoredModelsConfigValue(row);
  return { raw: value.raw, updatedAt: row.updated_at };
}

export function writeStoredModelsConfigRaw(
  agentDir: string,
  raw: string,
  options: OpenClawStateDatabaseOptions & { now?: () => number; relativePath?: string } = {},
): void {
  const row = modelsConfigToRow(agentDir, raw, options.now?.() ?? Date.now(), options.relativePath);
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<ModelsConfigDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("agent_model_catalogs")
        .values(row)
        .onConflict((conflict) =>
          conflict.column("catalog_key").doUpdateSet({
            agent_dir: row.agent_dir,
            relative_path: row.relative_path,
            raw_json: row.raw_json,
            updated_at: row.updated_at,
          }),
        ),
    );
  }, options);
}

export function listStoredPluginModelCatalogs(
  agentDir: string,
  options: OpenClawStateDatabaseOptions = {},
): Array<{ relativePath: string; raw: string; updatedAt: number }> {
  const database = openOpenClawStateDatabase(options);
  const db = getNodeSqliteKysely<ModelsConfigDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("agent_model_catalogs")
      .select(["relative_path", "raw_json", "updated_at"])
      .where("agent_dir", "=", path.resolve(agentDir))
      .where("relative_path", "!=", "")
      .orderBy("relative_path", "asc"),
  ).rows;
  return rows.map((row) => ({
    relativePath: row.relative_path,
    raw: row.raw_json,
    updatedAt: row.updated_at,
  }));
}

export function deleteStoredModelsConfigRaw(
  agentDir: string,
  relativePath: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  let changed = 0n;
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<ModelsConfigDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("agent_model_catalogs")
        .where("catalog_key", "=", modelsConfigKey(agentDir, relativePath)),
    );
    changed = result.numAffectedRows ?? 0n;
  }, options);
  return changed > 0n;
}
