import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  features: {
    legacyStateMigrations: true,
  },
  plugin: {
    specifier: "./api.js",
    exportName: "imessageSetupPlugin",
  },
  legacyStateMigrations: {
    specifier: "./doctor-legacy-state-api.js",
    exportName: "detectIMessageLegacyStateMigrations",
  },
});
