import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupVerifyCommand } from "../commands/backup-verify.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  buildExtensionsNodeModulesFilter,
  createBackupArchive,
  formatBackupCreateSummary,
  type BackupCreateResult,
} from "./backup-create.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";

function makeResult(overrides: Partial<BackupCreateResult> = {}): BackupCreateResult {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    archiveRoot: "openclaw-backup-2026-01-01",
    archivePath: "/tmp/openclaw-backup.tar.gz",
    dryRun: false,
    includeWorkspace: true,
    onlyConfig: false,
    verified: false,
    assets: [],
    skipped: [],
    skippedVolatileCount: 0,
    ...overrides,
  };
}

type BackupCreateTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "diagnostic_events" | "backup_runs" | "delivery_queue_entries"
>;

async function listArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push(entry.path);
      entry.resume();
    },
  });
  return entries;
}

async function listArchiveEntryTypes(
  archivePath: string,
): Promise<Array<{ path: string; type: string }>> {
  const entries: Array<{ path: string; type: string }> = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push({ path: entry.path, type: entry.type });
      entry.resume();
    },
  });
  return entries;
}

async function extractArchiveToTemp(archivePath: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-test-extract-"));
  await tar.x({
    file: archivePath,
    gzip: true,
    cwd: tempDir,
  });
  return tempDir;
}

function countDeliveryQueueRows(sqlitePath: string): number {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get() as
      | { count?: number | bigint }
      | undefined;
    const count = row?.count ?? 0;
    return typeof count === "bigint" ? Number(count) : count;
  } finally {
    db.close();
  }
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("formatBackupCreateSummary", () => {
  const backupArchiveLine = "Backup archive: /tmp/openclaw-backup.tar.gz";

  it.each([
    {
      name: "formats created archives with included and skipped paths",
      result: makeResult({
        verified: true,
        assets: [
          {
            kind: "state",
            sourcePath: "/state",
            archivePath: "archive/state",
            displayPath: "~/.openclaw",
          },
        ],
        skipped: [
          {
            kind: "workspace",
            sourcePath: "/workspace",
            displayPath: "~/Projects/openclaw",
            reason: "covered",
            coveredBy: "~/.openclaw",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 1 path:",
        "- state: ~/.openclaw",
        "Skipped 1 path:",
        "- workspace: ~/Projects/openclaw (covered by ~/.openclaw)",
        "Created /tmp/openclaw-backup.tar.gz",
        "Archive verification: passed",
      ],
    },
    {
      name: "formats dry runs and pluralized counts",
      result: makeResult({
        dryRun: true,
        assets: [
          {
            kind: "config",
            sourcePath: "/config",
            archivePath: "archive/config",
            displayPath: "~/.openclaw/config.json",
          },
          {
            kind: "credentials",
            sourcePath: "/oauth",
            archivePath: "archive/oauth",
            displayPath: "~/.openclaw/oauth",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 2 paths:",
        "- config: ~/.openclaw/config.json",
        "- credentials: ~/.openclaw/oauth",
        "Dry run only; archive was not written.",
      ],
    },
  ])("$name", ({ result, expected }) => {
    expect(formatBackupCreateSummary(result)).toEqual(expected);
  });
});

describe("buildExtensionsNodeModulesFilter", () => {
  it("excludes dependency trees only under state extensions", () => {
    const filter = buildExtensionsNodeModulesFilter("/state/");

    expect(filter("/state/extensions/demo/openclaw.plugin.json")).toBe(true);
    expect(filter("/state/extensions/demo/src/index.js")).toBe(true);
    expect(filter("/state/extensions/demo/node_modules/dep/index.js")).toBe(false);
    expect(filter("/state/extensions/demo/vendor/node_modules/dep/index.js")).toBe(false);
    expect(filter("/state/node_modules/dep/index.js")).toBe(true);
    expect(filter("/state/extensions-node_modules/demo/index.js")).toBe(true);
  });

  it("normalizes Windows path separators", () => {
    const filter = buildExtensionsNodeModulesFilter("C:\\Users\\me\\.openclaw\\");

    expect(filter(String.raw`C:\Users\me\.openclaw\extensions\demo\index.js`)).toBe(true);
    expect(
      filter(String.raw`C:\Users\me\.openclaw\extensions\demo\node_modules\dep\index.js`),
    ).toBe(false);
  });
});

describe("createBackupArchive", () => {
  it("falls back when injected nowMs is outside Date range", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-invalid-now-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));

        try {
          const result = await createBackupArchive({
            output: outputDir,
            dryRun: true,
            includeWorkspace: false,
            nowMs: 8_640_000_000_000_001,
          });

          expect(result.createdAt).toBe("2026-05-30T12:00:00.000Z");
          expect(path.basename(result.archivePath)).toContain("openclaw-backup.tar.gz");
          expect(path.basename(result.archivePath)).not.toContain("NaN");
        } finally {
          dateNowSpy.mockRestore();
        }
      },
    );
  });

  it("falls back to epoch when injected nowMs and Date.now are outside Date range", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-invalid-fallback-now-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

        try {
          const result = await createBackupArchive({
            output: outputDir,
            dryRun: true,
            includeWorkspace: false,
            nowMs: 8_640_000_000_000_001,
          });

          expect(result.createdAt).toBe("1970-01-01T00:00:00.000Z");
          expect(path.basename(result.archivePath)).toContain("openclaw-backup.tar.gz");
          expect(path.basename(result.archivePath)).not.toContain("NaN");
        } finally {
          dateNowSpy.mockRestore();
        }
      },
    );
  });

  it("omits installed plugin node_modules from the real archive while keeping plugin files", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-plugin-deps-",
        scenario: "minimal",
      },
      async (state) => {
        const stateDir = state.stateDir;
        const outputDir = state.path("backups");
        await fs.mkdir(path.join(stateDir, "extensions", "demo", "node_modules", "dep"), {
          recursive: true,
        });
        await fs.mkdir(path.join(stateDir, "extensions", "demo", "src"), { recursive: true });
        await fs.mkdir(path.join(stateDir, "node_modules", "root-dep"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "openclaw.plugin.json"),
          '{"id":"demo"}\n',
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "src", "index.js"),
          "export default {}\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "node_modules", "dep", "index.js"),
          "module.exports = {}\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "node_modules", "root-dep", "index.js"),
          "module.exports = {}\n",
          "utf8",
        );
        await fs.mkdir(outputDir, { recursive: true });
        const database = openOpenClawStateDatabase();
        const db = getNodeSqliteKysely<BackupCreateTestDatabase>(database.db);
        executeSqliteQuerySync(
          database.db,
          db.insertInto("diagnostic_events").values({
            scope: "backup-test",
            event_key: "seed",
            payload_json: "{}",
            created_at: 1,
          }),
        );

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 3, 28, 12, 0, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);

        const entrySuffixes = entries.map((entry) => entry.replace(/^.*\/state\//, "/state/"));
        expect(entrySuffixes).toContain("/state/extensions/demo/openclaw.plugin.json");
        expect(entrySuffixes).toContain("/state/extensions/demo/src/index.js");
        expect(entrySuffixes).toContain("/state/node_modules/root-dep/index.js");
        const pluginNodeModuleEntries = entries.filter((entry) =>
          entry.includes("/state/extensions/demo/node_modules/"),
        );
        expect(pluginNodeModuleEntries).toEqual([]);
        expect(
          entries.some((entry) => entry.endsWith("/state/node_modules/root-dep/index.js")),
        ).toBe(true);
        expect(entries.some((entry) => entry.endsWith("/state/state/openclaw.sqlite"))).toBe(true);

        const backupRuns = executeSqliteQuerySync(
          database.db,
          db.selectFrom("backup_runs").selectAll(),
        ).rows;
        expect(backupRuns).toHaveLength(1);
        expect(backupRuns[0]?.archive_path).toBe(result.archivePath);
        expect(backupRuns[0]?.status).toBe("completed");
        const manifest = JSON.parse(backupRuns[0]?.manifest_json ?? "{}") as {
          databaseSnapshots?: Array<{
            role?: string;
            archivePath?: string;
            integrity?: string;
          }>;
        };
        expect(manifest.databaseSnapshots).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "global",
              integrity: "ok",
              archivePath: expect.stringContaining("/state/state/openclaw.sqlite"),
            }),
          ]),
        );

        const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
        expect(verification.ok).toBe(true);
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "stores hardlinked workspace files as regular files so verification accepts the archive",
    async () => {
      await withOpenClawTestState(
        {
          layout: "split",
          prefix: "openclaw-backup-hardlink-",
          scenario: "minimal",
        },
        async (state) => {
          await state.writeConfig({
            agents: { defaults: { workspace: state.workspaceDir } },
          });
          const outputDir = state.path("backups");
          await fs.mkdir(outputDir, { recursive: true });
          const sourcePath = path.join(state.workspaceDir, "source.txt");
          const linkedPath = path.join(state.workspaceDir, "linked.txt");
          await fs.writeFile(sourcePath, "same inode\n", "utf8");
          await fs.link(sourcePath, linkedPath);

          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: true,
            nowMs: Date.UTC(2026, 4, 12, 12, 0, 0),
          });
          const entries = await listArchiveEntryTypes(result.archivePath);
          const hardlinkedEntries = entries.filter(
            (entry) =>
              entry.path.endsWith("/workspace/source.txt") ||
              entry.path.endsWith("/workspace/linked.txt"),
          );
          expect(hardlinkedEntries).toHaveLength(2);
          expect(hardlinkedEntries.map((entry) => entry.type)).toEqual(["File", "File"]);

          const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
          expect(verification.ok).toBe(true);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "omits symlinks from state and workspace archives so verification accepts the archive",
    async () => {
      await withOpenClawTestState(
        {
          layout: "split",
          prefix: "openclaw-backup-symlink-skip-",
          scenario: "minimal",
        },
        async (state) => {
          await state.writeConfig({
            agents: { defaults: { workspace: state.workspaceDir } },
          });
          const outputDir = state.path("backups");
          await fs.mkdir(outputDir, { recursive: true });

          const workspaceTarget = path.join(state.workspaceDir, "source.txt");
          const workspaceLink = path.join(state.workspaceDir, "linked.txt");
          await fs.writeFile(workspaceTarget, "workspace target\n", "utf8");
          await fs.symlink(workspaceTarget, workspaceLink);

          const stateTarget = path.join(state.stateDir, "state-target.txt");
          const stateLink = path.join(state.stateDir, "state-link.txt");
          await fs.writeFile(stateTarget, "state target\n", "utf8");
          await fs.symlink(stateTarget, stateLink);

          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: true,
            nowMs: Date.UTC(2026, 4, 13, 12, 0, 0),
          });
          const entries = await listArchiveEntryTypes(result.archivePath);
          expect(
            entries.filter((entry) => entry.type === "SymbolicLink" || entry.type === "Link"),
          ).toEqual([]);
          expect(entries.some((entry) => entry.path.endsWith("/workspace/linked.txt"))).toBe(false);
          expect(entries.some((entry) => entry.path.endsWith("/state/state-link.txt"))).toBe(false);

          const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
          expect(verification.ok).toBe(true);
        },
      );
    },
  );

  it("omits volatile live state files from the staged archive", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-volatile-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(path.join(state.stateDir, "logs", "nested"), { recursive: true });
        await fs.mkdir(path.join(state.stateDir, "delivery-queue"), { recursive: true });
        await fs.mkdir(path.join(state.stateDir, "sessions", "s-abc"), { recursive: true });
        await fs.writeFile(path.join(state.stateDir, "logs", "nested", "gateway.log"), "tail\n");
        await fs.writeFile(path.join(state.stateDir, "gateway.pid"), "123\n");
        await fs.writeFile(path.join(state.stateDir, "ipc.sock"), "");
        await fs.writeFile(path.join(state.stateDir, "delivery-queue", "pending.json"), "{}\n");
        await fs.writeFile(path.join(state.stateDir, "sessions", "s-abc", "meta.json"), "{}\n");
        await fs.mkdir(outputDir, { recursive: true });

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 4, 10, 12, 0, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);

        expect(entries.some((entry) => entry.endsWith("/state/logs/nested/gateway.log"))).toBe(
          false,
        );
        expect(entries.some((entry) => entry.endsWith("/state/gateway.pid"))).toBe(false);
        expect(entries.some((entry) => entry.endsWith("/state/ipc.sock"))).toBe(false);
        expect(entries.some((entry) => entry.endsWith("/state/delivery-queue/pending.json"))).toBe(
          false,
        );
        expect(entries.some((entry) => entry.endsWith("/state/sessions/s-abc/meta.json"))).toBe(
          true,
        );
        expect(result.skippedVolatileCount).toBe(4);
      },
    );
  });

  it("scrubs volatile delivery queue rows from SQLite snapshots", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-queue-scrub-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const database = openOpenClawStateDatabase();
        const db = getNodeSqliteKysely<BackupCreateTestDatabase>(database.db);
        executeSqliteQuerySync(
          database.db,
          db.insertInto("delivery_queue_entries").values({
            queue_name: "outbound",
            id: "queued-send",
            status: "pending",
            entry_kind: "message",
            session_key: "session-1",
            channel: "telegram",
            target: "chat-1",
            account_id: null,
            entry_json: JSON.stringify({ text: "do not replay" }),
            enqueued_at: 1,
            updated_at: 1,
          }),
        );

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 4, 11, 12, 0, 0),
        });
        const stateAsset = result.assets.find((asset) => asset.kind === "state");
        expect(stateAsset).toBeDefined();
        const extractDir = await extractArchiveToTemp(result.archivePath);
        try {
          const archivedStateDb = path.join(
            extractDir,
            stateAsset!.archivePath,
            "state",
            "openclaw.sqlite",
          );
          expect(countDeliveryQueueRows(archivedStateDb)).toBe(0);
        } finally {
          await fs.rm(extractDir, { recursive: true, force: true });
        }
      },
    );
  });

  it("does not duplicate the root manifest when the system tempdir lives inside the state dir", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-tmp-overlap-",
        scenario: "minimal",
      },
      async (state) => {
        const stateDir = state.stateDir;
        const outputDir = state.path("backups");
        const overlappingTmp = path.join(stateDir, "tmp");
        await fs.mkdir(overlappingTmp, { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        const tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(overlappingTmp);

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 12, 0, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const rootManifestEntries = entries.filter(
            (entry) => entry.endsWith("/manifest.json") && !entry.includes("/payload/"),
          );
          expect(rootManifestEntries).toHaveLength(1);

          const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
          expect(verification.ok).toBe(true);
        } finally {
          tmpdirSpy.mockRestore();
        }
      },
    );
  });

  it("does not duplicate the root manifest when the system tempdir is the state dir itself", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-tmp-equals-state-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(state.stateDir);

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 12, 0, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const rootManifestEntries = entries.filter(
            (entry) => entry.endsWith("/manifest.json") && !entry.includes("/payload/"),
          );
          expect(rootManifestEntries).toHaveLength(1);

          const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
          expect(verification.ok).toBe(true);
        } finally {
          tmpdirSpy.mockRestore();
        }
      },
    );
  });
});
