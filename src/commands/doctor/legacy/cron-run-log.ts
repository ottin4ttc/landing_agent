import fs from "node:fs/promises";
import path from "node:path";
import { parseCronRunLogEntriesFromJsonl } from "../../../cron/run-log-jsonl.js";
import { appendCronRunLog } from "../../../cron/run-log.js";
import { pathExists, root as fsRoot } from "../../../infra/fs-safe.js";

export async function legacyCronRunLogFilesExist(legacyStorePath: string): Promise<boolean> {
  const runsDir = path.resolve(path.dirname(path.resolve(legacyStorePath)), "runs");
  if (!(await pathExists(runsDir))) {
    return false;
  }
  const runsRoot = await fsRoot(runsDir).catch(() => null);
  if (!runsRoot) {
    return false;
  }
  const files = await runsRoot.list(".", { withFileTypes: true }).catch(() => []);
  return files.some((entry) => entry.isFile && entry.name.endsWith(".jsonl"));
}

export async function importLegacyCronRunLogFilesToSqlite(params: {
  legacyStorePath: string;
  storeKey: string;
  opts?: { maxBytes?: number; keepLines?: number };
}): Promise<{ imported: number; files: number; removedDir?: string }> {
  const runsDir = path.resolve(path.dirname(path.resolve(params.legacyStorePath)), "runs");
  if (!(await pathExists(runsDir))) {
    return { imported: 0, files: 0 };
  }
  const runsRoot = await fsRoot(runsDir).catch(() => null);
  if (!runsRoot) {
    return { imported: 0, files: 0 };
  }
  const files = (await runsRoot.list(".", { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name);
  let imported = 0;
  for (const fileName of files) {
    const raw = await runsRoot.readText(fileName).catch(() => "");
    // Legacy run-log files are named "<jobId>.jsonl"; the entries omit the jobId,
    // so derive it from the filename for parsing into SQLite.
    const jobId = path.basename(fileName, ".jsonl");
    for (const entry of parseCronRunLogEntriesFromJsonl(raw, { jobId })) {
      await appendCronRunLog({ storePath: params.storeKey, entry, opts: params.opts });
      imported++;
    }
    await fs.rm(path.join(runsDir, fileName), { force: true }).catch(() => undefined);
  }
  let removedDir: string | undefined;
  try {
    const remaining = await runsRoot.list(".", { withFileTypes: true });
    if (remaining.length === 0) {
      await fs.rmdir(runsDir);
      removedDir = runsDir;
    }
  } catch {
    // best-effort cleanup only
  }
  return { imported, files: files.length, removedDir };
}
