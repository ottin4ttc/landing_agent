import path from "node:path";
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import { loadPersistedAuthProfileStoreEntry } from "./auth-profiles/persisted.js";
import { MODEL_CATALOG_STATE } from "./models-config-state.js";
import {
  deleteStoredModelsConfigRaw,
  listStoredPluginModelCatalogs,
  readStoredModelsConfigRaw,
  writeStoredModelsConfigRaw,
} from "./models-config-store.js";
import { planOpenClawModelCatalog } from "./models-config.plan.js";
import {
  decodePluginModelCatalogRelativePathPluginId,
  isGeneratedPluginModelCatalog,
  isPluginModelCatalogRelativePath,
  resolvePluginModelCatalogOwnerPluginId,
} from "./plugin-model-catalog.js";

export {
  resetModelCatalogReadyCacheForTest,
  resetModelCatalogReadyCacheForTest as resetModelsJsonReadyCacheForTest,
} from "./models-config-state.js";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

async function buildModelCatalogFingerprint(params: {
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
  agentDir: string;
  stateOptions?: OpenClawStateDatabaseOptions;
  workspaceDir?: string;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index">;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
}): Promise<string> {
  const authProfilesUpdatedAt =
    loadPersistedAuthProfileStoreEntry(params.agentDir, params.stateOptions)?.updatedAt ?? null;
  const storedModelsConfig = readStoredModelsConfigRaw(params.agentDir, params.stateOptions);
  const pluginCatalogs = listStoredPluginModelCatalogs(params.agentDir, params.stateOptions).map(
    (entry) => [entry.relativePath, entry.updatedAt] satisfies [string, number],
  );
  const envShape = createConfigRuntimeEnv(params.config, {});
  const pluginMetadataSnapshotIndexFingerprint = params.pluginMetadataSnapshot
    ? resolveInstalledManifestRegistryIndexFingerprint(params.pluginMetadataSnapshot.index)
    : undefined;
  return stableStringify({
    config: params.config,
    sourceConfigForSecrets: params.sourceConfigForSecrets,
    envShape,
    authProfilesUpdatedAt,
    storedModelsConfigUpdatedAt: storedModelsConfig?.updatedAt,
    pluginCatalogs,
    workspaceDir: params.workspaceDir,
    pluginMetadataSnapshotIndexFingerprint,
    providerDiscoveryProviderIds: params.providerDiscoveryProviderIds,
    providerDiscoveryTimeoutMs: params.providerDiscoveryTimeoutMs,
    providerDiscoveryEntriesOnly: params.providerDiscoveryEntriesOnly === true,
  });
}

function modelCatalogReadyCacheKey(targetPath: string, fingerprint: string): string {
  return `${targetPath}\0${fingerprint}`;
}

function resolveModelCatalogStateOptions(agentDir: string): OpenClawStateDatabaseOptions {
  const resolved = path.resolve(agentDir);
  if (path.basename(resolved) !== "agent") {
    return {};
  }
  const agentIdDir = path.dirname(resolved);
  const agentsDir = path.dirname(agentIdDir);
  if (path.basename(agentsDir) !== "agents") {
    return {};
  }
  return {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: path.dirname(agentsDir),
    },
  };
}

async function readExistingModelsConfig(agentDir: string): Promise<{
  raw: string;
  parsed: unknown;
}> {
  try {
    const stored = readStoredModelsConfigRaw(agentDir, resolveModelCatalogStateOptions(agentDir));
    if (!stored) {
      return {
        raw: "",
        parsed: null,
      };
    }
    return {
      raw: stored.raw,
      parsed: JSON.parse(stored.raw) as unknown,
    };
  } catch {
    return {
      raw: "",
      parsed: null,
    };
  }
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredModelCatalogRaw(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function readGeneratedPluginCatalog(params: {
  agentDir: string;
  relativePath: string;
  stateOptions: OpenClawStateDatabaseOptions;
}): unknown {
  const stored = readStoredModelsConfigRaw(
    params.agentDir,
    params.stateOptions,
    params.relativePath,
  );
  if (!stored) {
    return undefined;
  }
  const parsed = parseStoredModelCatalogRaw(stored.raw);
  return isGeneratedPluginModelCatalog(parsed) ? parsed : undefined;
}

function mergeGeneratedPluginCatalogProvidersIntoExistingParsed(params: {
  agentDir: string;
  existingParsed: unknown;
  stateOptions: OpenClawStateDatabaseOptions;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "owners">;
}): unknown {
  const root = isRecordLike(params.existingParsed) ? params.existingParsed : {};
  const providers = isRecordLike(root.providers) ? { ...root.providers } : {};
  let changed = false;
  for (const { relativePath } of listStoredPluginModelCatalogs(
    params.agentDir,
    params.stateOptions,
  )) {
    const catalogPluginId = decodePluginModelCatalogRelativePathPluginId(relativePath);
    if (!catalogPluginId) {
      continue;
    }
    const catalog = readGeneratedPluginCatalog({
      agentDir: params.agentDir,
      relativePath,
      stateOptions: params.stateOptions,
    });
    if (!isRecordLike(catalog) || !isRecordLike(catalog.providers)) {
      continue;
    }
    for (const [providerId, provider] of Object.entries(catalog.providers)) {
      const currentOwnerPluginId = resolvePluginModelCatalogOwnerPluginId({
        providerId,
        pluginMetadataSnapshot: params.pluginMetadataSnapshot,
      });
      if (currentOwnerPluginId !== catalogPluginId) {
        continue;
      }
      providers[providerId] = provider;
      changed = true;
    }
  }
  if (!changed) {
    return params.existingParsed;
  }
  return { ...root, providers };
}

function removeStalePluginCatalogs(params: {
  agentDir: string;
  activeRelativePaths: ReadonlySet<string>;
  stateOptions: OpenClawStateDatabaseOptions;
}): boolean {
  let wrote = false;
  for (const { relativePath, raw } of listStoredPluginModelCatalogs(
    params.agentDir,
    params.stateOptions,
  )) {
    if (params.activeRelativePaths.has(path.normalize(relativePath))) {
      continue;
    }
    const parsed = parseStoredModelCatalogRaw(raw);
    if (!isGeneratedPluginModelCatalog(parsed)) {
      continue;
    }
    wrote =
      deleteStoredModelsConfigRaw(params.agentDir, relativePath, params.stateOptions) || wrote;
  }
  return wrote;
}

function writePluginCatalogsForModelCatalog(params: {
  agentDir: string;
  stateOptions: OpenClawStateDatabaseOptions;
  pluginCatalogWrites?: Record<string, string>;
}): boolean {
  if (!params.pluginCatalogWrites) {
    return false;
  }
  let wrote = false;
  const activeRelativePaths = new Set<string>();
  for (const [relativePath, contents] of Object.entries(params.pluginCatalogWrites)) {
    if (!isPluginModelCatalogRelativePath(relativePath)) {
      continue;
    }
    const normalizedRelativePath = path.normalize(relativePath);
    activeRelativePaths.add(normalizedRelativePath);
    const existing = readStoredModelsConfigRaw(
      params.agentDir,
      params.stateOptions,
      normalizedRelativePath,
    );
    if (existing?.raw === contents) {
      continue;
    }
    writeStoredModelsConfigRaw(params.agentDir, contents, {
      ...params.stateOptions,
      relativePath: normalizedRelativePath,
    });
    wrote = true;
  }
  return (
    wrote ||
    removeStalePluginCatalogs({
      agentDir: params.agentDir,
      activeRelativePaths,
      stateOptions: params.stateOptions,
    })
  );
}

function resolveModelsConfigInput(config?: OpenClawConfig): {
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
} {
  const runtimeSource = getRuntimeConfigSourceSnapshot();
  if (!config) {
    const loaded = getRuntimeConfig();
    return {
      config: runtimeSource ?? loaded,
      sourceConfigForSecrets: runtimeSource ?? loaded,
    };
  }
  if (!runtimeSource) {
    return {
      config,
      sourceConfigForSecrets: config,
    };
  }
  const projected = projectConfigOntoRuntimeSourceSnapshot(config);
  return {
    config: projected,
    // If projection is skipped (for example incompatible top-level shape),
    // keep managed secret persistence anchored to the active source snapshot.
    sourceConfigForSecrets: projected === config ? runtimeSource : projected,
  };
}

async function withModelCatalogWriteLock<T>(targetPath: string, run: () => Promise<T>): Promise<T> {
  const prior = MODEL_CATALOG_STATE.writeLocks.get(targetPath) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = prior.then(() => gate);
  MODEL_CATALOG_STATE.writeLocks.set(targetPath, pending);
  try {
    await prior;
    return await run();
  } finally {
    release();
    if (MODEL_CATALOG_STATE.writeLocks.get(targetPath) === pending) {
      MODEL_CATALOG_STATE.writeLocks.delete(targetPath);
    }
  }
}

export async function ensureOpenClawModelCatalog(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: {
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    workspaceDir?: string;
    providerDiscoveryProviderIds?: readonly string[];
    providerDiscoveryTimeoutMs?: number;
    providerDiscoveryEntriesOnly?: boolean;
  } = {},
): Promise<{ agentDir: string; wrote: boolean }> {
  const resolved = resolveModelsConfigInput(config);
  const cfg = resolved.config;
  const workspaceDir =
    options.workspaceDir ??
    (agentDirOverride?.trim()
      ? undefined
      : resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
  const providerScopedDiscovery = Boolean(options.providerDiscoveryProviderIds?.length);
  const pluginMetadataSnapshot =
    options.pluginMetadataSnapshot ??
    resolvePluginMetadataSnapshot({
      config: cfg,
      env: createConfigRuntimeEnv(cfg),
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(providerScopedDiscovery ? { preferPersisted: false } : {}),
    });
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveDefaultAgentDir(cfg);
  const stateOptions = resolveModelCatalogStateOptions(agentDir);
  const targetKey = `${stateOptions.env?.OPENCLAW_STATE_DIR ?? ""}\0${path.resolve(agentDir)}`;
  const fingerprint = await buildModelCatalogFingerprint({
    config: cfg,
    sourceConfigForSecrets: resolved.sourceConfigForSecrets,
    agentDir,
    stateOptions,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    ...(options.providerDiscoveryProviderIds
      ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds }
      : {}),
    ...(options.providerDiscoveryTimeoutMs !== undefined
      ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs }
      : {}),
    ...(options.providerDiscoveryEntriesOnly === true
      ? { providerDiscoveryEntriesOnly: true }
      : {}),
  });
  const cacheKey = modelCatalogReadyCacheKey(targetKey, fingerprint);
  const cached = MODEL_CATALOG_STATE.readyCache.get(cacheKey);
  if (cached) {
    const settled = await cached;
    return settled.result;
  }

  const pending = withModelCatalogWriteLock(targetKey, async () => {
    // Ensure config env vars (e.g. AWS_PROFILE, AWS_ACCESS_KEY_ID) are
    // are available to provider discovery without mutating process.env.
    const env = createConfigRuntimeEnv(cfg);
    const existingModelCatalog = await readExistingModelsConfig(agentDir);
    const existingParsedForMerge = mergeGeneratedPluginCatalogProvidersIntoExistingParsed({
      agentDir,
      existingParsed: existingModelCatalog.parsed,
      stateOptions,
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    });
    const plan = await planOpenClawModelCatalog({
      cfg,
      sourceConfigForSecrets: resolved.sourceConfigForSecrets,
      agentDir,
      env,
      ...(workspaceDir ? { workspaceDir } : {}),
      existingRaw: existingModelCatalog.raw,
      existingParsed: existingParsedForMerge,
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
      ...(options.providerDiscoveryProviderIds
        ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds }
        : {}),
      ...(options.providerDiscoveryTimeoutMs !== undefined
        ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs }
        : {}),
      ...(options.providerDiscoveryEntriesOnly === true
        ? { providerDiscoveryEntriesOnly: true }
        : {}),
    });

    if (plan.action === "skip") {
      const wrotePluginCatalog = writePluginCatalogsForModelCatalog({
        agentDir,
        stateOptions,
        pluginCatalogWrites: plan.pluginCatalogWrites,
      });
      return { fingerprint, result: { agentDir, wrote: wrotePluginCatalog } };
    }

    if (plan.action === "noop") {
      const wrotePluginCatalog = writePluginCatalogsForModelCatalog({
        agentDir,
        stateOptions,
        pluginCatalogWrites: plan.pluginCatalogWrites,
      });
      return { fingerprint, result: { agentDir, wrote: wrotePluginCatalog } };
    }

    const existingRoot = existingModelCatalog.raw;
    const wroteRoot = existingRoot !== plan.contents;
    if (wroteRoot) {
      writeStoredModelsConfigRaw(agentDir, plan.contents, stateOptions);
    }
    const wrotePluginCatalog = writePluginCatalogsForModelCatalog({
      agentDir,
      stateOptions,
      pluginCatalogWrites: plan.pluginCatalogWrites,
    });
    return { fingerprint, result: { agentDir, wrote: wroteRoot || wrotePluginCatalog } };
  });
  MODEL_CATALOG_STATE.readyCache.set(cacheKey, pending);
  try {
    const settled = await pending;
    const refreshedFingerprint = await buildModelCatalogFingerprint({
      config: cfg,
      sourceConfigForSecrets: resolved.sourceConfigForSecrets,
      agentDir,
      stateOptions,
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
      ...(options.providerDiscoveryProviderIds
        ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds }
        : {}),
      ...(options.providerDiscoveryTimeoutMs !== undefined
        ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs }
        : {}),
      ...(options.providerDiscoveryEntriesOnly === true
        ? { providerDiscoveryEntriesOnly: true }
        : {}),
    });
    const refreshedCacheKey = modelCatalogReadyCacheKey(targetKey, refreshedFingerprint);
    if (refreshedCacheKey !== cacheKey) {
      MODEL_CATALOG_STATE.readyCache.delete(cacheKey);
      MODEL_CATALOG_STATE.readyCache.set(
        refreshedCacheKey,
        Promise.resolve({ fingerprint: refreshedFingerprint, result: settled.result }),
      );
    }
    return settled.result;
  } catch (error) {
    if (MODEL_CATALOG_STATE.readyCache.get(cacheKey) === pending) {
      MODEL_CATALOG_STATE.readyCache.delete(cacheKey);
    }
    throw error;
  }
}

export const ensureOpenClawModelsJson = ensureOpenClawModelCatalog;
