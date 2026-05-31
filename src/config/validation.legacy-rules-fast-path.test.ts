import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacyConfigRule } from "./legacy.shared.js";

const { collectChannelLegacyConfigRulesMock, listPluginDoctorLegacyConfigRulesMock } = vi.hoisted(
  () => ({
    collectChannelLegacyConfigRulesMock: vi.fn((): LegacyConfigRule[] => []),
    listPluginDoctorLegacyConfigRulesMock: vi.fn((): LegacyConfigRule[] => []),
  }),
);
const loadPluginMetadataSnapshotMock = vi.hoisted(() =>
  vi.fn(() => ({
    manifestRegistry: {
      diagnostics: [],
      plugins: [],
    },
    plugins: [],
  })),
);

vi.mock("../commands/doctor/shared/channel-legacy-config-rules.js", () => ({
  collectChannelLegacyConfigRules: collectChannelLegacyConfigRulesMock,
}));

vi.mock("../plugins/doctor-contract-registry.js", () => ({
  listPluginDoctorLegacyConfigRules: listPluginDoctorLegacyConfigRulesMock,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
  resolvePluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
}));

import { validateConfigObjectRaw } from "./validation.js";

describe("config validation legacy rule loading", () => {
  beforeEach(() => {
    collectChannelLegacyConfigRulesMock.mockReset();
    collectChannelLegacyConfigRulesMock.mockReturnValue([]);
    listPluginDoctorLegacyConfigRulesMock.mockReset();
    listPluginDoctorLegacyConfigRulesMock.mockReturnValue([]);
    loadPluginMetadataSnapshotMock.mockClear();
  });

  it("does not load channel or plugin doctor legacy rules for valid raw config", () => {
    collectChannelLegacyConfigRulesMock.mockReturnValue([
      {
        path: ["channels", "discord", "legacy"],
        message: "legacy discord key",
      },
    ]);

    const result = validateConfigObjectRaw({
      channels: {
        discord: {},
      },
    });

    expect(result.ok).toBe(true);
    expect(collectChannelLegacyConfigRulesMock).not.toHaveBeenCalled();
    expect(listPluginDoctorLegacyConfigRulesMock).not.toHaveBeenCalled();
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("does not load plugin doctor legacy rules for invalid raw config", () => {
    listPluginDoctorLegacyConfigRulesMock.mockReturnValue([
      {
        path: ["plugins", "entries", "demo", "legacy"],
        message: "legacy demo key",
      },
    ]);

    const result = validateConfigObjectRaw({
      plugins: {
        entries: {
          demo: {
            legacy: true,
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(collectChannelLegacyConfigRulesMock).not.toHaveBeenCalled();
    expect(listPluginDoctorLegacyConfigRulesMock).not.toHaveBeenCalled();
  });

  it("skips enabled-only and empty-config plugin entries", () => {
    const result = validateConfigObjectRaw({
      plugins: {
        entries: {
          anthropic: {
            enabled: true,
          },
          discord: {
            config: {},
            enabled: true,
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(collectChannelLegacyConfigRulesMock).not.toHaveBeenCalled();
    expect(listPluginDoctorLegacyConfigRulesMock).not.toHaveBeenCalled();
  });

  it("does not use touched paths to load doctor rules during raw validation", () => {
    const result = validateConfigObjectRaw(
      {
        plugins: {
          entries: {
            demo: {},
            other: {},
          },
        },
      },
      {
        touchedPaths: [["plugins", "entries", "demo", "enabled"]],
      },
    );

    expect(result.ok).toBe(true);
    expect(collectChannelLegacyConfigRulesMock).not.toHaveBeenCalled();
    expect(listPluginDoctorLegacyConfigRulesMock).not.toHaveBeenCalled();
  });

  it("accepts legacy session config keys before doctor repair runs", () => {
    const result = validateConfigObjectRaw({
      session: {
        store: { path: "sessions.json" },
        idleMinutes: 120.9,
        resetByType: {
          dm: { mode: "idle", idleMinutes: 45 },
          group: { mode: "daily", atHour: 8 },
        },
        maintenance: { enabled: true },
        writeLock: { staleMs: 1000 },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.session).toEqual({
        reset: { mode: "idle", idleMinutes: 120 },
        resetByType: {
          direct: { mode: "idle", idleMinutes: 45 },
          group: { mode: "daily", atHour: 8 },
        },
      });
    }
    expect(collectChannelLegacyConfigRulesMock).not.toHaveBeenCalled();
    expect(listPluginDoctorLegacyConfigRulesMock).not.toHaveBeenCalled();
  });

  it("accepts legacy diagnostics cache trace file paths before doctor repair runs", () => {
    const result = validateConfigObjectRaw({
      diagnostics: {
        cacheTrace: {
          enabled: true,
          includePrompt: false,
          filePath: "/tmp/openclaw-cache-trace.jsonl",
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.diagnostics?.cacheTrace).toEqual({
        enabled: true,
        includePrompt: false,
      });
    }
    expect(collectChannelLegacyConfigRulesMock).not.toHaveBeenCalled();
    expect(listPluginDoctorLegacyConfigRulesMock).not.toHaveBeenCalled();
  });
});
