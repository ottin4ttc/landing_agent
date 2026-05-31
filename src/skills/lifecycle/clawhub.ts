import crypto from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import {
  downloadClawHubSkillArchive,
  fetchClawHubSkillDetail,
  resolveClawHubBaseUrl,
  searchClawHubSkills,
  type ClawHubSkillDetail,
  type ClawHubSkillSearchResult,
} from "../../infra/clawhub.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { pathExists } from "../../infra/fs-safe.js";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import { tryReadJson, writeJson } from "../../infra/json-files.js";
import {
  createCorePluginStateKeyedStore,
  createCorePluginStateSyncKeyedStore,
} from "../../plugin-state/plugin-state-store.js";
import {
  CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
  installExtractedSkillRoot,
  normalizeTrackedSkillSlug,
  resolveWorkspaceSkillInstallDir,
  validateRequestedSkillSlug,
} from "./archive-install.js";

const CLAWHUB_SKILL_STATE_OWNER_ID = "core:clawhub-skills";
const CLAWHUB_SKILL_STATE_NAMESPACE = "skill-installs";
const CLAWHUB_SKILL_STATE_MAX_ENTRIES = 10_000;
const CLAWHUB_DOT_DIR = ".clawhub";
const LEGACY_CLAWHUB_DOT_DIR = ".clawdhub";
const LOCAL_SKILL_CARD_FILENAME = "skill-card.md";
const LOCAL_SKILL_CARD_MAX_BYTES = 256 * 1024;

const clawHubSkillInstallStore = createCorePluginStateKeyedStore<ClawHubSkillInstallRecord>({
  ownerId: CLAWHUB_SKILL_STATE_OWNER_ID,
  namespace: CLAWHUB_SKILL_STATE_NAMESPACE,
  maxEntries: CLAWHUB_SKILL_STATE_MAX_ENTRIES,
});
const clawHubSkillInstallSyncStore = createCorePluginStateSyncKeyedStore<ClawHubSkillInstallRecord>(
  {
    ownerId: CLAWHUB_SKILL_STATE_OWNER_ID,
    namespace: CLAWHUB_SKILL_STATE_NAMESPACE,
    maxEntries: CLAWHUB_SKILL_STATE_MAX_ENTRIES,
  },
);

type TrackedClawHubSkillInstall = {
  version: 1;
  registry: string;
  slug: string;
  installedVersion: string;
  installedAt: number;
};

type TrackedClawHubSkills = {
  version: 1;
  skills: Record<
    string,
    {
      version: string;
      installedAt: number;
      registry?: string;
    }
  >;
};

export type ClawHubSkillsLockfile = TrackedClawHubSkills;

export type ClawHubSkillsLockfileStatusRead =
  | { kind: "found"; lock: ClawHubSkillsLockfile; path: string }
  | { kind: "missing" }
  | { kind: "malformed"; path: string; error: string };

export type ClawHubSkillStatusLink =
  | {
      status: "linked";
      valid: true;
      registry: string;
      slug: string;
      installedVersion: string;
      installedAt: number;
      originPath: string;
      lockPath: string;
    }
  | {
      status: "invalid";
      valid: false;
      reason: string;
      registry?: string;
      slug?: string;
      installedVersion?: string;
      installedAt?: number;
      originPath?: string;
      lockPath?: string;
    };

export type LocalSkillCardStatus = {
  present: true;
  path: string;
  sizeBytes: number;
};

type LocalSkillCardRead = LocalSkillCardStatus & {
  content?: string;
};

type ClawHubSkillInstallRecord = TrackedClawHubSkillInstall & {
  workspaceDir: string;
  targetDir: string;
  updatedAt: number;
};

export type InstallClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      version: string;
      targetDir: string;
      detail: ClawHubSkillDetail;
    }
  | { ok: false; error: string };

export type UpdateClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      previousVersion: string | null;
      version: string;
      changed: boolean;
      targetDir: string;
    }
  | { ok: false; error: string };

export type ClawHubSkillVerificationResolutionSource = "installed" | "registry";
export type ClawHubSkillVerificationSelector = "installed-version" | "version" | "tag" | "latest";

export type ClawHubSkillVerificationTargetResult =
  | {
      ok: true;
      slug: string;
      baseUrl: string;
      version: string | undefined;
      tag: string | undefined;
      resolution: {
        source: ClawHubSkillVerificationResolutionSource;
        selector: ClawHubSkillVerificationSelector;
        registry: string;
        skillDir: string | undefined;
        installedVersion: string | undefined;
      };
    }
  | {
      ok: false;
      error: string;
    };

type Logger = {
  info?: (message: string) => void;
};

async function resolveRequestedUpdateSlug(params: {
  workspaceDir: string;
  requestedSlug: string;
  tracked: TrackedClawHubSkills;
}): Promise<string> {
  const trackedSlug = normalizeTrackedSkillSlug(params.requestedSlug);
  const trackedTargetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, trackedSlug);
  const trackedInstall = await readTrackedClawHubSkillInstall(trackedTargetDir);
  if (trackedInstall || params.tracked.skills[trackedSlug]) {
    return trackedSlug;
  }
  return validateRequestedSkillSlug(params.requestedSlug);
}

type ClawHubInstallParams = {
  workspaceDir: string;
  slug: string;
  version?: string;
  baseUrl?: string;
  force?: boolean;
  logger?: Logger;
};

type TrackedUpdateTarget =
  | {
      ok: true;
      slug: string;
      baseUrl?: string;
      previousVersion: string | null;
    }
  | {
      ok: false;
      slug: string;
      error: string;
    };

function resolveClawHubWorkspaceDirFromSkillDir(skillDir: string): string | null {
  const resolved = path.resolve(skillDir);
  const skillsDir = path.dirname(resolved);
  if (path.basename(skillsDir) !== "skills") {
    return null;
  }
  return path.dirname(skillsDir);
}

function clawHubWorkspaceKey(workspaceDir: string): string {
  return crypto.createHash("sha256").update(path.resolve(workspaceDir)).digest("hex").slice(0, 24);
}

function clawHubSkillInstallKey(workspaceDir: string, slug: string): string {
  return `${clawHubWorkspaceKey(workspaceDir)}:${normalizeTrackedSkillSlug(slug)}`;
}

function recordToTrackedInstall(record: ClawHubSkillInstallRecord): TrackedClawHubSkillInstall {
  return {
    version: 1,
    registry: record.registry,
    slug: record.slug,
    installedVersion: record.installedVersion,
    installedAt: record.installedAt,
  };
}

function trackedSkillsFromRows(
  workspaceDir: string,
  rows: ReadonlyArray<{ key: string; value: ClawHubSkillInstallRecord }>,
): TrackedClawHubSkills {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const keyPrefix = `${clawHubWorkspaceKey(resolvedWorkspaceDir)}:`;
  const trackedSkills: TrackedClawHubSkills["skills"] = {};
  for (const row of rows) {
    if (
      !row.key.startsWith(keyPrefix) ||
      path.resolve(row.value.workspaceDir) !== resolvedWorkspaceDir
    ) {
      continue;
    }
    trackedSkills[row.value.slug] = {
      version: row.value.installedVersion,
      installedAt: row.value.installedAt,
      registry: row.value.registry,
    };
  }
  return { version: 1, skills: trackedSkills };
}

async function readTrackedClawHubSkills(workspaceDir: string): Promise<TrackedClawHubSkills> {
  return trackedSkillsFromRows(workspaceDir, await clawHubSkillInstallStore.entries());
}

function readTrackedClawHubSkillsSync(workspaceDir: string): TrackedClawHubSkills {
  return trackedSkillsFromRows(workspaceDir, clawHubSkillInstallSyncStore.entries());
}

async function writeTrackedClawHubSkills(
  workspaceDir: string,
  tracked: TrackedClawHubSkills,
): Promise<void> {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  for (const [slug, entry] of Object.entries(tracked.skills)) {
    const targetDir = resolveWorkspaceSkillInstallDir(resolvedWorkspaceDir, slug);
    const existing = await readTrackedClawHubSkillInstall(targetDir);
    await clawHubSkillInstallStore.register(clawHubSkillInstallKey(resolvedWorkspaceDir, slug), {
      version: 1,
      registry: existing?.registry ?? resolveClawHubBaseUrl(undefined),
      slug,
      installedVersion: entry.version,
      installedAt: entry.installedAt,
      workspaceDir: resolvedWorkspaceDir,
      targetDir,
      updatedAt: Date.now(),
    });
  }
}

async function untrackLegacyClawHubSkillLock(workspaceDir: string, slug: string): Promise<void> {
  for (const dotDir of [CLAWHUB_DOT_DIR, LEGACY_CLAWHUB_DOT_DIR]) {
    const lockPath = path.join(workspaceDir, dotDir, "lock.json");
    let lock: Partial<TrackedClawHubSkills> | null = null;
    try {
      lock = await tryReadJson<Partial<TrackedClawHubSkills>>(lockPath);
    } catch {
      continue;
    }
    if (lock?.version !== 1 || !lock.skills || typeof lock.skills !== "object") {
      continue;
    }
    if (!lock.skills[slug]) {
      continue;
    }
    delete lock.skills[slug];
    await writeJson(lockPath, { version: 1, skills: lock.skills }, { trailingNewline: true });
  }
}

async function readTrackedClawHubSkillInstall(
  skillDir: string,
): Promise<TrackedClawHubSkillInstall | null> {
  const resolvedSkillDir = path.resolve(skillDir);
  const workspaceDir = resolveClawHubWorkspaceDirFromSkillDir(resolvedSkillDir);
  if (workspaceDir) {
    const slug = path.basename(resolvedSkillDir);
    const row = await clawHubSkillInstallStore.lookup(clawHubSkillInstallKey(workspaceDir, slug));
    if (row) {
      return recordToTrackedInstall(row);
    }
  }

  return null;
}

function readTrackedClawHubSkillInstallSync(skillDir: string): TrackedClawHubSkillInstall | null {
  const resolvedSkillDir = path.resolve(skillDir);
  const workspaceDir = resolveClawHubWorkspaceDirFromSkillDir(resolvedSkillDir);
  if (workspaceDir) {
    const slug = path.basename(resolvedSkillDir);
    const row = clawHubSkillInstallSyncStore.lookup(clawHubSkillInstallKey(workspaceDir, slug));
    if (row) {
      return recordToTrackedInstall(row);
    }
  }

  return null;
}

async function writeTrackedClawHubSkillInstall(
  skillDir: string,
  install: TrackedClawHubSkillInstall,
): Promise<void> {
  const resolvedSkillDir = path.resolve(skillDir);
  const workspaceDir = resolveClawHubWorkspaceDirFromSkillDir(resolvedSkillDir);
  if (!workspaceDir) {
    throw new Error(`Invalid ClawHub skill install directory: ${skillDir}`);
  }
  await clawHubSkillInstallStore.register(clawHubSkillInstallKey(workspaceDir, install.slug), {
    ...install,
    workspaceDir: path.resolve(workspaceDir),
    targetDir: resolvedSkillDir,
    updatedAt: Date.now(),
  });
}

function normalizeStoredRegistry(registry: string): string {
  const trimmed = registry.trim();
  return trimmed.replace(/\/+$/, "") || trimmed;
}

function normalizeOptionalSelector(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function skillStateRef(suffix: string): string {
  return `sqlite:plugin-state/${CLAWHUB_SKILL_STATE_OWNER_ID}/${CLAWHUB_SKILL_STATE_NAMESPACE}/${suffix}`;
}

export async function readClawHubSkillsLockfile(
  workspaceDir: string,
): Promise<ClawHubSkillsLockfile> {
  return await readTrackedClawHubSkills(workspaceDir);
}

export function readClawHubSkillsLockfileStatusSync(
  workspaceDir: string,
): ClawHubSkillsLockfileStatusRead {
  const lock = readTrackedClawHubSkillsSync(workspaceDir);
  if (Object.keys(lock.skills).length === 0) {
    return { kind: "missing" };
  }
  return {
    kind: "found",
    lock,
    path: skillStateRef(`${clawHubWorkspaceKey(workspaceDir)}:*`),
  };
}

type StrictOriginReadResult =
  | { kind: "found"; origin: TrackedClawHubSkillInstall; path: string }
  | { kind: "missing" }
  | { kind: "malformed"; path: string; error: string };

async function readClawHubSkillOriginStrict(skillDir: string): Promise<StrictOriginReadResult> {
  const install = await readTrackedClawHubSkillInstall(skillDir);
  if (!install) {
    return { kind: "missing" };
  }
  return {
    kind: "found",
    origin: install,
    path: skillStateRef(clawHubSkillInstallKey(path.dirname(path.dirname(skillDir)), install.slug)),
  };
}

function readRealPathSync(candidate: string): string | undefined {
  try {
    return fsSync.realpathSync.native(candidate);
  } catch {
    return undefined;
  }
}

export function resolveClawHubSkillStatusLinkSync(params: {
  workspaceDir: string;
  skillDir: string;
  skillKey: string;
  lockRead?: ClawHubSkillsLockfileStatusRead;
}): ClawHubSkillStatusLink | undefined {
  const install = readTrackedClawHubSkillInstallSync(params.skillDir);
  const lockRead = params.lockRead ?? readClawHubSkillsLockfileStatusSync(params.workspaceDir);
  const lockPath = lockRead.kind === "found" ? lockRead.path : undefined;
  if (!install) {
    let trackedSlug: string;
    try {
      trackedSlug = normalizeTrackedSkillSlug(params.skillKey);
    } catch {
      return undefined;
    }
    const locked = lockRead.kind === "found" ? lockRead.lock.skills[trackedSlug] : undefined;
    if (!locked) {
      return undefined;
    }
    return {
      status: "invalid",
      valid: false,
      reason: `Skill "${trackedSlug}" is tracked by SQLite ClawHub state but is missing local ClawHub install metadata.`,
      slug: trackedSlug,
      installedVersion: locked.version,
      installedAt: locked.installedAt,
      registry: normalizeStoredRegistry(locked.registry ?? resolveClawHubBaseUrl()),
      lockPath,
    };
  }

  const trackedSlug = normalizeTrackedSkillSlug(install.slug);
  const expectedSkillDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, trackedSlug);
  const expectedSkillDirRealPath = readRealPathSync(expectedSkillDir);
  const actualSkillDirRealPath = readRealPathSync(params.skillDir);
  const originPath = skillStateRef(clawHubSkillInstallKey(params.workspaceDir, trackedSlug));
  if (!expectedSkillDirRealPath || actualSkillDirRealPath !== expectedSkillDirRealPath) {
    return {
      status: "invalid",
      valid: false,
      reason: `Skill "${trackedSlug}" ClawHub install metadata is not in the expected ClawHub install directory.`,
      registry: normalizeStoredRegistry(install.registry),
      slug: trackedSlug,
      installedVersion: install.installedVersion,
      installedAt: install.installedAt,
      originPath,
      lockPath,
    };
  }
  return {
    status: "linked",
    valid: true,
    registry: normalizeStoredRegistry(install.registry),
    slug: trackedSlug,
    installedVersion: install.installedVersion,
    installedAt: install.installedAt,
    originPath,
    lockPath: lockPath ?? originPath,
  };
}

export function resolveLocalSkillCardStatusSync(
  skillDir: string,
): LocalSkillCardStatus | undefined {
  return readLocalSkillCardSync(skillDir);
}

function isPathInsideDir(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function readLocalSkillCardSync(
  skillDir: string,
  includeContent = false,
): LocalSkillCardRead | undefined {
  const cardPath = path.join(skillDir, LOCAL_SKILL_CARD_FILENAME);
  let lstat: fsSync.Stats;
  try {
    lstat = fsSync.lstatSync(cardPath);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
  if (!lstat.isFile() || lstat.size > LOCAL_SKILL_CARD_MAX_BYTES) {
    return undefined;
  }

  let fd: number | undefined;
  try {
    const realCardPath = fsSync.realpathSync.native(cardPath);
    const realSkillDir = fsSync.realpathSync.native(skillDir);
    if (!isPathInsideDir(realCardPath, realSkillDir)) {
      return undefined;
    }
    const noFollowFlag = fsSync.constants.O_NOFOLLOW ?? 0;
    fd = fsSync.openSync(cardPath, fsSync.constants.O_RDONLY | noFollowFlag);
    const fdStat = fsSync.fstatSync(fd);
    if (!fdStat.isFile() || fdStat.size > LOCAL_SKILL_CARD_MAX_BYTES) {
      return undefined;
    }
    const result: LocalSkillCardRead = {
      present: true,
      path: cardPath,
      sizeBytes: fdStat.size,
    };
    if (includeContent) {
      result.content = fsSync.readFileSync(fd, "utf8");
    }
    return result;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fsSync.closeSync(fd);
      } catch {
        // ignore close errors while reporting the card as unavailable
      }
    }
  }
}

export function readLocalSkillCardContentSync(skillDir: string): string | undefined {
  return readLocalSkillCardSync(skillDir, true)?.content;
}

export async function searchSkillsFromClawHub(params: {
  query?: string;
  limit?: number;
  baseUrl?: string;
}): Promise<ClawHubSkillSearchResult[]> {
  return await searchClawHubSkills({
    query: params.query?.trim() || "*",
    limit: params.limit,
    baseUrl: params.baseUrl,
  });
}

export async function resolveClawHubSkillVerificationTarget(params: {
  workspaceDir: string;
  slug: string;
  version?: string;
  tag?: string;
  baseUrl?: string;
}): Promise<ClawHubSkillVerificationTargetResult> {
  try {
    const version = normalizeOptionalSelector(params.version);
    const tag = normalizeOptionalSelector(params.tag);
    if (version && tag) {
      return { ok: false, error: "Use either --version or --tag." };
    }

    const trackedSlug = normalizeTrackedSkillSlug(params.slug);
    const skillDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, trackedSlug);
    const originRead = await readClawHubSkillOriginStrict(skillDir);
    if (originRead.kind === "malformed") {
      return {
        ok: false,
        error: `Malformed ClawHub origin metadata at ${originRead.path}: ${originRead.error}`,
      };
    }

    if (originRead.kind === "found") {
      const lock = await readClawHubSkillsLockfile(params.workspaceDir);
      const locked = lock.skills[trackedSlug];
      if (!locked) {
        return {
          ok: false,
          error: `Skill "${trackedSlug}" has ClawHub origin metadata but is not tracked by the workspace ClawHub lockfile. Reinstall it from ClawHub before verifying it as an installed ClawHub skill.`,
        };
      }
      const originSlug = normalizeTrackedSkillSlug(originRead.origin.slug);
      if (originSlug !== trackedSlug) {
        return {
          ok: false,
          error: `Skill "${trackedSlug}" has ClawHub origin metadata for "${originRead.origin.slug}". Reinstall it from ClawHub before verifying it as an installed ClawHub skill.`,
        };
      }
      const originRegistry = normalizeStoredRegistry(originRead.origin.registry);
      const lockedRegistry =
        locked.registry === undefined ? originRegistry : normalizeStoredRegistry(locked.registry);
      if (
        locked.version !== originRead.origin.installedVersion ||
        locked.installedAt !== originRead.origin.installedAt ||
        lockedRegistry !== originRegistry
      ) {
        return {
          ok: false,
          error: `Skill "${trackedSlug}" ClawHub origin metadata does not match the workspace ClawHub lockfile. Reinstall it from ClawHub before verifying it as an installed ClawHub skill.`,
        };
      }
      const selector: ClawHubSkillVerificationSelector = version
        ? "version"
        : tag
          ? "tag"
          : "installed-version";
      return {
        ok: true,
        slug: trackedSlug,
        baseUrl: lockedRegistry,
        version: version ?? (tag ? undefined : locked.version),
        tag,
        resolution: {
          source: "installed",
          selector,
          registry: lockedRegistry,
          skillDir,
          installedVersion: locked.version,
        },
      };
    }

    const lockRead = readClawHubSkillsLockfileStatusSync(params.workspaceDir);
    if (lockRead.kind === "malformed") {
      return {
        ok: false,
        error: `Malformed workspace ClawHub lockfile at ${lockRead.path}: ${lockRead.error}`,
      };
    }
    if (lockRead.kind === "found" && lockRead.lock.skills[trackedSlug]) {
      return {
        ok: false,
        error: `Skill "${trackedSlug}" is tracked by the workspace ClawHub lockfile but is missing ClawHub origin metadata. Reinstall it from ClawHub before verifying it as an installed ClawHub skill.`,
      };
    }

    const slug = validateRequestedSkillSlug(params.slug);
    const registry = resolveClawHubBaseUrl(params.baseUrl);
    const selector: ClawHubSkillVerificationSelector = version ? "version" : tag ? "tag" : "latest";
    return {
      ok: true,
      slug,
      baseUrl: registry,
      version,
      tag,
      resolution: {
        source: "registry",
        selector,
        registry,
        skillDir: undefined,
        installedVersion: undefined,
      },
    };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

async function resolveInstallVersion(params: {
  slug: string;
  version?: string;
  baseUrl?: string;
}): Promise<{ detail: ClawHubSkillDetail; version: string }> {
  const detail = await fetchClawHubSkillDetail({
    slug: params.slug,
    baseUrl: params.baseUrl,
  });
  if (!detail.skill) {
    throw new Error(`Skill "${params.slug}" not found on ClawHub.`);
  }
  const resolvedVersion = params.version ?? detail.latestVersion?.version;
  if (!resolvedVersion) {
    throw new Error(`Skill "${params.slug}" has no installable version.`);
  }
  return {
    detail,
    version: resolvedVersion,
  };
}

async function performClawHubSkillInstall(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    const { detail, version } = await resolveInstallVersion({
      slug: params.slug,
      version: params.version,
      baseUrl: params.baseUrl,
    });
    const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
    if (!params.force && (await pathExists(targetDir))) {
      return {
        ok: false,
        error: `Skill already exists at ${targetDir}. Re-run with force/update.`,
      };
    }

    params.logger?.info?.(`Downloading ${params.slug}@${version} from ClawHub…`);
    const archive = await downloadClawHubSkillArchive({
      slug: params.slug,
      version,
      baseUrl: params.baseUrl,
    });
    try {
      const install = await withExtractedArchiveRoot({
        archivePath: archive.archivePath,
        tempDirPrefix: "openclaw-skill-clawhub-",
        timeoutMs: 120_000,
        rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
        onExtracted: async (rootDir) =>
          await installExtractedSkillRoot({
            workspaceDir: params.workspaceDir,
            slug: params.slug,
            extractedRoot: rootDir,
            mode: params.force ? "update" : "install",
            logger: params.logger,
            scan: false,
            rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
          }),
      });
      if (!install.ok) {
        return { ok: false, error: install.error };
      }

      const installedAt = Date.now();
      await writeTrackedClawHubSkillInstall(install.targetDir, {
        version: 1,
        registry: resolveClawHubBaseUrl(params.baseUrl),
        slug: params.slug,
        installedVersion: version,
        installedAt,
      });
      const tracked = await readTrackedClawHubSkills(params.workspaceDir);
      tracked.skills[params.slug] = {
        version,
        installedAt,
        registry: resolveClawHubBaseUrl(params.baseUrl),
      };
      await writeTrackedClawHubSkills(params.workspaceDir, tracked);

      return {
        ok: true,
        slug: params.slug,
        version,
        targetDir: install.targetDir,
        detail,
      };
    } finally {
      await archive.cleanup().catch(() => undefined);
    }
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
    };
  }
}

async function installRequestedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    return await performClawHubSkillInstall({
      ...params,
      slug: validateRequestedSkillSlug(params.slug),
    });
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
    };
  }
}

async function installTrackedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    return await performClawHubSkillInstall({
      ...params,
      slug: normalizeTrackedSkillSlug(params.slug),
    });
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
    };
  }
}

async function resolveTrackedUpdateTarget(params: {
  workspaceDir: string;
  slug: string;
  tracked: TrackedClawHubSkills;
  baseUrl?: string;
}): Promise<TrackedUpdateTarget> {
  const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
  const trackedInstall = (await readTrackedClawHubSkillInstall(targetDir)) ?? null;
  if (!trackedInstall && !params.tracked.skills[params.slug]) {
    return {
      ok: false,
      slug: params.slug,
      error: `Skill "${params.slug}" is not tracked as a ClawHub install.`,
    };
  }
  return {
    ok: true,
    slug: params.slug,
    baseUrl: trackedInstall?.registry ?? params.baseUrl,
    previousVersion:
      trackedInstall?.installedVersion ?? params.tracked.skills[params.slug]?.version ?? null,
  };
}

export async function installSkillFromClawHub(params: {
  workspaceDir: string;
  slug: string;
  version?: string;
  baseUrl?: string;
  force?: boolean;
  logger?: Logger;
}): Promise<InstallClawHubSkillResult> {
  return await installRequestedSkillFromClawHub(params);
}

export async function updateSkillsFromClawHub(params: {
  workspaceDir: string;
  slug?: string;
  baseUrl?: string;
  logger?: Logger;
}): Promise<UpdateClawHubSkillResult[]> {
  const tracked = await readTrackedClawHubSkills(params.workspaceDir);
  const slugs = params.slug
    ? [
        await resolveRequestedUpdateSlug({
          workspaceDir: params.workspaceDir,
          requestedSlug: params.slug,
          tracked,
        }),
      ]
    : Object.keys(tracked.skills).map((slug) => normalizeTrackedSkillSlug(slug));
  const results: UpdateClawHubSkillResult[] = [];
  for (const slug of slugs) {
    const target = await resolveTrackedUpdateTarget({
      workspaceDir: params.workspaceDir,
      slug,
      tracked,
      baseUrl: params.baseUrl,
    });
    if (!target.ok) {
      results.push({
        ok: false,
        error: target.error,
      });
      continue;
    }
    const install = await installTrackedSkillFromClawHub({
      workspaceDir: params.workspaceDir,
      slug: target.slug,
      baseUrl: target.baseUrl,
      force: true,
      logger: params.logger,
    });
    if (!install.ok) {
      results.push(install);
      continue;
    }
    results.push({
      ok: true,
      slug: target.slug,
      previousVersion: target.previousVersion,
      version: install.version,
      changed: target.previousVersion !== install.version,
      targetDir: install.targetDir,
    });
  }
  return results;
}

export async function readTrackedClawHubSkillSlugs(workspaceDir: string): Promise<string[]> {
  const tracked = await readTrackedClawHubSkills(workspaceDir);
  return Object.keys(tracked.skills).toSorted();
}

export async function untrackClawHubSkill(workspaceDir: string, slug: string): Promise<void> {
  const trackedSlug = normalizeTrackedSkillSlug(slug);
  await clawHubSkillInstallStore.delete(clawHubSkillInstallKey(workspaceDir, trackedSlug));
  await untrackLegacyClawHubSkillLock(workspaceDir, trackedSlug);
}
