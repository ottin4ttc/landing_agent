import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCorePluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";

const fetchClawHubSkillDetailMock = vi.fn();
const downloadClawHubSkillArchiveMock = vi.fn();
const listClawHubSkillsMock = vi.fn();
const resolveClawHubBaseUrlMock = vi.fn(() => "https://clawhub.ai");
const searchClawHubSkillsMock = vi.fn();
const archiveCleanupMock = vi.fn();
const withExtractedArchiveRootMock = vi.fn();
const installPackageDirMock = vi.fn();
const pathExistsMock = vi.fn();
const tempStateDirs: string[] = [];
const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;

vi.mock("../infra/clawhub.js", () => ({
  fetchClawHubSkillDetail: fetchClawHubSkillDetailMock,
  downloadClawHubSkillArchive: downloadClawHubSkillArchiveMock,
  listClawHubSkills: listClawHubSkillsMock,
  resolveClawHubBaseUrl: resolveClawHubBaseUrlMock,
  searchClawHubSkills: searchClawHubSkillsMock,
}));

vi.mock("../infra/install-flow.js", () => ({
  withExtractedArchiveRoot: withExtractedArchiveRootMock,
}));

vi.mock("../infra/install-package-dir.js", () => ({
  installPackageDir: installPackageDirMock,
}));

vi.mock("../infra/fs-safe.js", () => ({
  pathExists: pathExistsMock,
}));

const {
  installSkillFromClawHub,
  resolveClawHubSkillVerificationTarget,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} = await import("./skills-clawhub.js");

function expectInstallPackageSourceDir(sourceDir: string) {
  const call = installPackageDirMock.mock.calls.at(0);
  if (!call) {
    throw new Error("expected installPackageDir call");
  }
  expect(call[0]?.sourceDir).toBe(sourceDir);
}

function expectInstalledSkill(
  result: Awaited<ReturnType<typeof installSkillFromClawHub>>,
  expected: { slug?: string; version?: string; targetDir?: string } = {},
) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected skill install success, got ${result.error}`);
  }
  if (expected.slug) {
    expect(result.slug).toBe(expected.slug);
  }
  if (expected.version) {
    expect(result.version).toBe(expected.version);
  }
  if (expected.targetDir) {
    expect(result.targetDir).toBe(expected.targetDir);
  }
}

function expectInvalidSlug(result: Awaited<ReturnType<typeof installSkillFromClawHub>>) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected invalid slug failure");
  }
  expect(result.error).toContain("Invalid skill slug");
}

async function writeClawHubOriginFixture(params: {
  workspaceDir: string;
  slug: string;
  originSlug?: string;
  registry?: string;
  installedVersion?: string;
  installedAt?: number;
  writeLock?: boolean;
}) {
  const skillDir = path.join(params.workspaceDir, "skills", params.slug);
  const registry = params.registry ?? "https://private.example.com/clawhub";
  const installedVersion = params.installedVersion ?? "1.2.3";
  const installedAt = params.installedAt ?? 123;
  await fs.mkdir(skillDir, { recursive: true });
  if (params.writeLock !== false) {
    const workspaceKey = crypto
      .createHash("sha256")
      .update(path.resolve(params.workspaceDir))
      .digest("hex")
      .slice(0, 24);
    const store = createCorePluginStateKeyedStore<{
      version: 1;
      registry: string;
      slug: string;
      installedVersion: string;
      installedAt: number;
      workspaceDir: string;
      targetDir: string;
      updatedAt: number;
    }>({
      ownerId: "core:clawhub-skills",
      namespace: "skill-installs",
      maxEntries: 10_000,
    });
    await store.register(`${workspaceKey}:${params.slug}`, {
      version: 1,
      registry,
      slug: params.originSlug ?? params.slug,
      installedVersion,
      installedAt,
      workspaceDir: path.resolve(params.workspaceDir),
      targetDir: skillDir,
      updatedAt: installedAt,
    });
  }
  return skillDir;
}

describe("skills-clawhub", () => {
  beforeEach(async () => {
    fetchClawHubSkillDetailMock.mockReset();
    downloadClawHubSkillArchiveMock.mockReset();
    listClawHubSkillsMock.mockReset();
    resolveClawHubBaseUrlMock.mockReset();
    searchClawHubSkillsMock.mockReset();
    archiveCleanupMock.mockReset();
    withExtractedArchiveRootMock.mockReset();
    installPackageDirMock.mockReset();
    pathExistsMock.mockReset();
    resetPluginStateStoreForTests();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-clawhub-state-"));
    tempStateDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;

    resolveClawHubBaseUrlMock.mockImplementation((baseUrl?: string) =>
      (baseUrl ?? "https://clawhub.ai").replace(/\/+$/, ""),
    );
    pathExistsMock.mockImplementation(async (input: string) => input.endsWith("SKILL.md"));
    fetchClawHubSkillDetailMock.mockResolvedValue({
      skill: {
        slug: "agentreceipt",
        displayName: "AgentReceipt",
        createdAt: 1,
        updatedAt: 2,
      },
      latestVersion: {
        version: "1.0.0",
        createdAt: 3,
      },
    });
    downloadClawHubSkillArchiveMock.mockResolvedValue({
      archivePath: "/tmp/agentreceipt.zip",
      integrity: "sha256-test",
      cleanup: archiveCleanupMock,
    });
    archiveCleanupMock.mockResolvedValue(undefined);
    searchClawHubSkillsMock.mockResolvedValue([]);
    withExtractedArchiveRootMock.mockImplementation(async (params) => {
      expect(params.rootMarkers).toEqual(["SKILL.md", "skill.md", "skills.md", "SKILL.MD"]);
      return await params.onExtracted("/tmp/extracted-skill");
    });
    installPackageDirMock.mockResolvedValue({
      ok: true,
      targetDir: "/tmp/workspace/skills/agentreceipt",
    });
  });

  afterEach(async () => {
    resetPluginStateStoreForTests();
    if (originalOpenClawStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
    }
    await Promise.all(
      tempStateDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("installs ClawHub skills from flat-root archives", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-clawhub-"));
    tempStateDirs.push(workspaceDir);
    installPackageDirMock.mockResolvedValueOnce({
      ok: true,
      targetDir: path.join(workspaceDir, "skills", "agentreceipt"),
    });
    const result = await installSkillFromClawHub({
      workspaceDir,
      slug: "agentreceipt",
    });

    expect(downloadClawHubSkillArchiveMock).toHaveBeenCalledWith({
      slug: "agentreceipt",
      version: "1.0.0",
      baseUrl: undefined,
    });
    expectInstallPackageSourceDir("/tmp/extracted-skill");
    expectInstalledSkill(result, {
      slug: "agentreceipt",
      version: "1.0.0",
      targetDir: path.join(workspaceDir, "skills", "agentreceipt"),
    });
    await expect(fs.access(path.join(workspaceDir, ".clawhub", "lock.json"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
    await expect(
      fs.access(path.join(workspaceDir, "skills", "agentreceipt", ".clawhub", "origin.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it.each(["skill.md", "skills.md", "SKILL.MD"])(
    "installs ClawHub archives whose packed root uses legacy marker %s",
    async (marker) => {
      pathExistsMock.mockImplementation(async (input: string) => input.endsWith(marker));

      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "agentreceipt",
      });

      expectInstalledSkill(result);
      expectInstallPackageSourceDir("/tmp/extracted-skill");
    },
  );

  describe("SQLite tracked slugs remain updatable", () => {
    async function createTrackedSkillFixture(slug: string) {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-clawhub-"));
      const skillDir = path.join(workspaceDir, "skills", slug);
      await fs.mkdir(skillDir, { recursive: true });
      const workspaceKey = crypto
        .createHash("sha256")
        .update(path.resolve(workspaceDir))
        .digest("hex")
        .slice(0, 24);
      const store = createCorePluginStateKeyedStore<{
        version: 1;
        registry: string;
        slug: string;
        installedVersion: string;
        installedAt: number;
        workspaceDir: string;
        targetDir: string;
        updatedAt: number;
      }>({
        ownerId: "core:clawhub-skills",
        namespace: "skill-installs",
        maxEntries: 10_000,
      });
      await store.register(`${workspaceKey}:${slug}`, {
        version: 1,
        registry: "https://legacy.clawhub.ai",
        slug,
        installedVersion: "0.9.0",
        installedAt: 123,
        workspaceDir: path.resolve(workspaceDir),
        targetDir: skillDir,
        updatedAt: 123,
      });
      return { workspaceDir, skillDir };
    }

    function expectTrackedUpdateSuccess(results: unknown, workspaceDir: string, slug: string) {
      expect(Array.isArray(results)).toBe(true);
      const first = (results as Array<Record<string, unknown>>)[0];
      expect(first?.ok).toBe(true);
      expect(first?.slug).toBe(slug);
      expect(first?.previousVersion).toBe("0.9.0");
      expect(first?.version).toBe("1.0.0");
      expect(first?.targetDir).toBe(path.join(workspaceDir, "skills", slug));
    }

    it("updates all SQLite-tracked Unicode slugs in place", async () => {
      const slug = "re\u0430ct";
      const { workspaceDir } = await createTrackedSkillFixture(slug);
      installPackageDirMock.mockResolvedValueOnce({
        ok: true,
        targetDir: path.join(workspaceDir, "skills", slug),
      });

      try {
        const results = await updateSkillsFromClawHub({
          workspaceDir,
        });

        expect(fetchClawHubSkillDetailMock).toHaveBeenCalledWith({
          slug,
          baseUrl: "https://legacy.clawhub.ai",
        });
        expect(downloadClawHubSkillArchiveMock).toHaveBeenCalledWith({
          slug,
          version: "1.0.0",
          baseUrl: "https://legacy.clawhub.ai",
        });
        expectTrackedUpdateSuccess(results, workspaceDir, slug);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("updates a SQLite-tracked Unicode slug when requested explicitly", async () => {
      const slug = "re\u0430ct";
      const { workspaceDir } = await createTrackedSkillFixture(slug);
      installPackageDirMock.mockResolvedValueOnce({
        ok: true,
        targetDir: path.join(workspaceDir, "skills", slug),
      });

      try {
        const results = await updateSkillsFromClawHub({
          workspaceDir,
          slug,
        });

        expectTrackedUpdateSuccess(results, workspaceDir, slug);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("still rejects an untracked Unicode slug passed to update", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-clawhub-"));

      try {
        await expect(
          updateSkillsFromClawHub({
            workspaceDir,
            slug: "re\u0430ct",
          }),
        ).rejects.toThrow("Invalid skill slug");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });

  describe("normalizeSlug rejects non-ASCII homograph slugs", () => {
    it("rejects Cyrillic homograph 'а' (U+0430) in slug", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "re\u0430ct",
      });
      expectInvalidSlug(result);
    });

    it("rejects Cyrillic homograph 'е' (U+0435) in slug", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "r\u0435act",
      });
      expectInvalidSlug(result);
    });

    it("rejects Cyrillic homograph 'о' (U+043E) in slug", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "t\u043Edo",
      });
      expectInvalidSlug(result);
    });

    it("rejects slug with mixed Unicode and ASCII", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "cаlеndаr",
      });
      expectInvalidSlug(result);
    });

    it("rejects slug with non-Latin scripts", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "技能",
      });
      expectInvalidSlug(result);
    });

    it("rejects Unicode that case-folds to ASCII (Kelvin sign U+212A)", async () => {
      // "\u212A" (Kelvin sign) lowercases to "k" — must be caught before lowercasing
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "\u212Aalendar",
      });
      expectInvalidSlug(result);
    });

    it("rejects slug starting with a hyphen", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "-calendar",
      });
      expectInvalidSlug(result);
    });

    it("rejects slug ending with a hyphen", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "calendar-",
      });
      expectInvalidSlug(result);
    });

    it("accepts uppercase ASCII slugs (preserves original casing behavior)", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "React",
      });
      expectInstalledSkill(result);
    });

    it("accepts valid lowercase ASCII slugs", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "calendar-2",
      });
      expectInstalledSkill(result);
    });
  });

  describe("verification target resolution", () => {
    it("uses installed origin registry and installed version by default", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        const skillDir = await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          registry: "https://private.example.com/clawhub/",
          installedVersion: "2.0.0",
        });

        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "agentreceipt",
          }),
        ).resolves.toEqual({
          ok: true,
          slug: "agentreceipt",
          baseUrl: "https://private.example.com/clawhub",
          version: "2.0.0",
          tag: undefined,
          resolution: {
            source: "installed",
            selector: "installed-version",
            registry: "https://private.example.com/clawhub",
            skillDir,
            installedVersion: "2.0.0",
          },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("keeps the installed registry when an explicit version overrides the installed version", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          registry: "https://private.example.com/clawhub",
          installedVersion: "2.0.0",
        });

        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "agentreceipt",
            version: "2.1.0",
            baseUrl: "https://clawhub.ai",
          }),
        ).resolves.toMatchObject({
          ok: true,
          slug: "agentreceipt",
          baseUrl: "https://private.example.com/clawhub",
          version: "2.1.0",
          tag: undefined,
          resolution: {
            source: "installed",
            selector: "version",
            registry: "https://private.example.com/clawhub",
            installedVersion: "2.0.0",
          },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("keeps the installed registry when an explicit tag is provided", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          registry: "https://private.example.com/clawhub",
          installedVersion: "2.0.0",
        });

        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "agentreceipt",
            tag: "beta",
            baseUrl: "https://clawhub.ai",
          }),
        ).resolves.toMatchObject({
          ok: true,
          slug: "agentreceipt",
          baseUrl: "https://private.example.com/clawhub",
          version: undefined,
          tag: "beta",
          resolution: {
            source: "installed",
            selector: "tag",
            registry: "https://private.example.com/clawhub",
            installedVersion: "2.0.0",
          },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("uses registry resolution when no SQLite install tracking exists", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          writeLock: false,
        });

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(result).toMatchObject({
          ok: true,
          resolution: { source: "registry", selector: "latest" },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("rejects installed origin metadata for a different skill slug", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          originSlug: "trusted-skill",
        });

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("expected slug mismatch failure");
        }
        expect(result.error).toContain("not tracked by the workspace ClawHub lockfile");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("uses updated SQLite install tracking", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          installedVersion: "2.0.0",
          installedAt: 123,
        });
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          installedVersion: "1.0.0",
          installedAt: 456,
        });

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(result).toMatchObject({
          ok: true,
          version: "1.0.0",
          resolution: {
            source: "installed",
            installedVersion: "1.0.0",
          },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("uses updated SQLite install registry", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          registry: "https://origin.example.com/clawhub",
          installedVersion: "2.0.0",
          installedAt: 123,
        });
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          registry: "https://other.example.com/clawhub",
          installedVersion: "2.0.0",
          installedAt: 456,
        });

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(result).toMatchObject({
          ok: true,
          baseUrl: "https://other.example.com/clawhub",
          resolution: {
            source: "installed",
            registry: "https://other.example.com/clawhub",
          },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("uses SQLite install tracking without legacy origin files", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          registry: "https://private.example.com/clawhub",
          installedVersion: "2.0.0",
          installedAt: 123,
        });

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(result).toMatchObject({
          ok: true,
          baseUrl: "https://private.example.com/clawhub",
          resolution: { source: "installed" },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("ignores malformed legacy workspace locks during runtime resolution", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
        await fs.writeFile(path.join(workspaceDir, ".clawhub", "lock.json"), "{not json", "utf8");

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(result).toMatchObject({
          ok: true,
          resolution: { source: "registry" },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("uses the configured registry and latest selector for uninstalled skills", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      resolveClawHubBaseUrlMock.mockReturnValueOnce("https://configured.example.com/clawhub");
      try {
        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "agentreceipt",
            baseUrl: "https://configured.example.com/clawhub/",
          }),
        ).resolves.toEqual({
          ok: true,
          slug: "agentreceipt",
          baseUrl: "https://configured.example.com/clawhub",
          version: undefined,
          tag: undefined,
          resolution: {
            source: "registry",
            selector: "latest",
            registry: "https://configured.example.com/clawhub",
            skillDir: undefined,
            installedVersion: undefined,
          },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("ignores malformed legacy origin metadata during runtime resolution", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        const skillDir = path.join(workspaceDir, "skills", "agentreceipt");
        await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
        await fs.writeFile(path.join(skillDir, ".clawhub", "origin.json"), "{not json", "utf8");

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(result).toMatchObject({
          ok: true,
          resolution: { source: "registry" },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("fails clearly for invalid slugs and conflicting selectors", async () => {
      await expect(
        resolveClawHubSkillVerificationTarget({
          workspaceDir: "/tmp/workspace",
          slug: "bad/slug",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "Invalid skill slug: bad/slug",
      });

      await expect(
        resolveClawHubSkillVerificationTarget({
          workspaceDir: "/tmp/workspace",
          slug: "agentreceipt",
          version: "1.0.0",
          tag: "latest",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "Use either --version or --tag.",
      });
    });
  });

  it("uses search for browse-all skill discovery", async () => {
    searchClawHubSkillsMock.mockResolvedValueOnce([
      {
        score: 1,
        slug: "calendar",
        displayName: "Calendar",
        summary: "Calendar skill",
        version: "1.2.3",
        updatedAt: 123,
      },
    ]);

    await expect(searchSkillsFromClawHub({ limit: 20 })).resolves.toEqual([
      {
        score: 1,
        slug: "calendar",
        displayName: "Calendar",
        summary: "Calendar skill",
        version: "1.2.3",
        updatedAt: 123,
      },
    ]);
    expect(searchClawHubSkillsMock).toHaveBeenCalledWith({
      query: "*",
      limit: 20,
      baseUrl: undefined,
    });
    expect(listClawHubSkillsMock).not.toHaveBeenCalled();
  });
});
