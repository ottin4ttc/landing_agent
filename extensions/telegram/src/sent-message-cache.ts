import { createHash } from "node:crypto";
import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateSyncKeyedStore,
  type PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";

const TTL_MS = 24 * 60 * 60 * 1000;
export const TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE = "telegram.sent-messages";
export const TELEGRAM_SENT_MESSAGE_CACHE_MAX_ENTRIES = 10_000;
const TELEGRAM_SENT_MESSAGES_STATE_KEY = Symbol.for("openclaw.telegramSentMessagesState");
const TELEGRAM_SENT_MESSAGES_STORE_FOR_TEST_KEY = Symbol.for(
  "openclaw.telegramSentMessagesStoreForTest",
);

type PersistedSentMessage = {
  scopeKey: string;
  chatId: string;
  messageId: string;
  timestamp: number;
};

function createPersistedSentMessageStore(
  env?: NodeJS.ProcessEnv,
): PluginStateSyncKeyedStore<PersistedSentMessage> {
  return createPluginStateSyncKeyedStore<PersistedSentMessage>("telegram", {
    namespace: TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE,
    maxEntries: TELEGRAM_SENT_MESSAGE_CACHE_MAX_ENTRIES,
    defaultTtlMs: TTL_MS,
    ...(env ? { env } : {}),
  });
}

const SENT_MESSAGE_STORE = createPersistedSentMessageStore();

type SentMessageStore = Map<string, Map<string, number>>;
type SentMessagePersistentStore = PluginStateSyncKeyedStore<PersistedSentMessage>;

type SentMessageBucket = {
  scopeKey: string;
  store: SentMessageStore;
};

type SentMessageState = {
  bucketsByScope: Map<string, SentMessageBucket>;
};

type SentMessageScopeOptions = {
  accountId?: string | null;
};

let sentMessageStoreForTest: SentMessagePersistentStore | undefined;

// Tests inject a store through both the module-local slot and a global symbol so
// fresh module instances (restart/shared-module specs) observe the same backing
// store. Without the global, importFreshModule would silently fork persistence.
function getSentMessageStoreForTest(): SentMessagePersistentStore | undefined {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  return (
    sentMessageStoreForTest ??
    (globalStore[TELEGRAM_SENT_MESSAGES_STORE_FOR_TEST_KEY] as
      | SentMessagePersistentStore
      | undefined)
  );
}

// Production reads/writes route here so an injected test store can stand in for
// the module-level persistent store while keeping the env-scoped doctor path
// (importSentMessageCacheEntry) talking to the right state database.
function openSentMessageStore(env?: NodeJS.ProcessEnv): SentMessagePersistentStore {
  const injected = getSentMessageStoreForTest();
  if (injected) {
    return injected;
  }
  return env ? createPersistedSentMessageStore(env) : SENT_MESSAGE_STORE;
}

function getSentMessageState(): SentMessageState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[TELEGRAM_SENT_MESSAGES_STATE_KEY] as SentMessageState | undefined;
  if (existing) {
    return existing;
  }
  const state: SentMessageState = {
    bucketsByScope: new Map(),
  };
  globalStore[TELEGRAM_SENT_MESSAGES_STATE_KEY] = state;
  return state;
}

function createSentMessageStore(): SentMessageStore {
  return new Map<string, Map<string, number>>();
}

function resolveSentMessageScopeKey(options?: SentMessageScopeOptions): string {
  const accountId = options?.accountId?.trim();
  return accountId || "default";
}

// Legacy migration scope is keyed by the session-store path, not by account.
// Both the current and legacy sidecar plans target the current store path, so
// migrated rows land in one runtime scope (see state-migrations sent-message specs).
function resolveLegacySentMessageScopeKey(cfg?: Pick<OpenClawConfig, "session">): string {
  const storePath = resolveStorePath(cfg?.session?.store);
  return createHash("sha256").update(storePath, "utf8").digest("hex").slice(0, 24);
}

function resolveSentMessageStorePath(cfg?: Pick<OpenClawConfig, "session">): string {
  return `${resolveStorePath(cfg?.session?.store)}.telegram-sent-messages.json`;
}

function sentMessageEntryKey(scopeKey: string, chatId: string, messageId: string): string {
  return createHash("sha256")
    .update(`${scopeKey}\0${chatId}\0${messageId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function importSentMessageCacheEntry(
  chatId: number | string,
  messageId: number | string,
  options?: SentMessageScopeOptions & { env?: NodeJS.ProcessEnv },
): void {
  const scopeKey = resolveSentMessageScopeKey(options);
  const chatKey = String(chatId);
  const idKey = String(messageId);
  openSentMessageStore(options?.env).register(
    sentMessageEntryKey(scopeKey, chatKey, idKey),
    {
      scopeKey,
      chatId: chatKey,
      messageId: idKey,
      timestamp: Date.now(),
    },
    { ttlMs: TTL_MS },
  );
}

function cleanupExpired(
  store: SentMessageStore,
  scopeKey: string,
  entry: Map<string, number>,
  now: number,
): void {
  for (const [id, timestamp] of entry) {
    if (now - timestamp >= TTL_MS) {
      entry.delete(id);
    }
  }
  if (entry.size === 0) {
    store.delete(scopeKey);
  }
}

function readPersistedSentMessages(scopeKey: string): SentMessageStore {
  const now = Date.now();
  const store = createSentMessageStore();
  try {
    for (const entry of openSentMessageStore().entries()) {
      if (entry.value.scopeKey !== scopeKey || now - entry.value.timestamp > TTL_MS) {
        continue;
      }
      let messages = store.get(entry.value.chatId);
      if (!messages) {
        messages = new Map<string, number>();
        store.set(entry.value.chatId, messages);
      }
      messages.set(entry.value.messageId, entry.value.timestamp);
    }
  } catch (error) {
    logVerbose(`telegram: failed to read sent-message cache: ${String(error)}`);
  }
  return store;
}

function readLegacySentMessages(filePath: string): SentMessageStore {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, Record<string, number>>;
    const now = Date.now();
    const store = createSentMessageStore();
    for (const [chatId, entry] of Object.entries(parsed)) {
      const messages = new Map<string, number>();
      for (const [messageId, timestamp] of Object.entries(entry)) {
        if (
          typeof timestamp === "number" &&
          Number.isFinite(timestamp) &&
          now - timestamp <= TTL_MS
        ) {
          messages.set(messageId, timestamp);
        }
      }
      if (messages.size > 0) {
        store.set(chatId, messages);
      }
    }
    return store;
  } catch (error) {
    logVerbose(`telegram: failed to read legacy sent-message cache: ${String(error)}`);
    return createSentMessageStore();
  }
}

function getSentMessageBucket(options?: SentMessageScopeOptions): SentMessageBucket {
  const state = getSentMessageState();
  const scopeKey = resolveSentMessageScopeKey(options);
  const existing = state.bucketsByScope.get(scopeKey);
  if (existing) {
    return existing;
  }
  const bucket = {
    scopeKey,
    store: readPersistedSentMessages(scopeKey),
  };
  state.bucketsByScope.set(scopeKey, bucket);
  return bucket;
}

function getSentMessages(options?: SentMessageScopeOptions): SentMessageStore {
  return getSentMessageBucket(options).store;
}

function persistSentMessages(bucket: SentMessageBucket): void {
  const { store, scopeKey } = bucket;
  const now = Date.now();
  const persistentStore = openSentMessageStore();
  for (const [chatId, entry] of store) {
    cleanupExpired(store, chatId, entry, now);
    for (const [messageId, timestamp] of entry) {
      // Persist with the remaining logical TTL so an aged row does not get its
      // expiry refreshed every time the bucket is flushed.
      const ttlMs = TTL_MS - Math.max(0, now - timestamp);
      if (ttlMs <= 0) {
        continue;
      }
      persistentStore.register(
        sentMessageEntryKey(scopeKey, chatId, messageId),
        { scopeKey, chatId, messageId, timestamp },
        { ttlMs },
      );
    }
  }
}

export function recordSentMessage(
  chatId: number | string,
  messageId: number,
  options?: SentMessageScopeOptions,
): void {
  const scopeKey = String(chatId);
  const idKey = String(messageId);
  const now = Date.now();
  const bucket = getSentMessageBucket(options);
  const { store } = bucket;
  let entry = store.get(scopeKey);
  if (!entry) {
    entry = new Map<string, number>();
    store.set(scopeKey, entry);
  }
  entry.set(idKey, now);
  if (entry.size > 100) {
    cleanupExpired(store, scopeKey, entry, now);
  }
  try {
    persistSentMessages(bucket);
  } catch (error) {
    logVerbose(`telegram: failed to persist sent-message cache: ${String(error)}`);
  }
}

export function wasSentByBot(
  chatId: number | string,
  messageId: number,
  options?: SentMessageScopeOptions,
): boolean {
  const scopeKey = String(chatId);
  const idKey = String(messageId);
  const store = getSentMessages(options);
  const entry = store.get(scopeKey);
  if (!entry) {
    return false;
  }
  cleanupExpired(store, scopeKey, entry, Date.now());
  return entry.has(idKey);
}

export function clearSentMessageCache(): void {
  const state = getSentMessageState();
  for (const bucket of state.bucketsByScope.values()) {
    bucket.store.clear();
  }
  state.bucketsByScope.clear();
  openSentMessageStore().clear();
}

export function resetSentMessageCacheForTest(): void {
  getSentMessageState().bucketsByScope.clear();
}

export function setTelegramSentMessageStoreForTest(
  store: SentMessagePersistentStore | undefined,
): void {
  sentMessageStoreForTest = store;
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  if (store) {
    globalStore[TELEGRAM_SENT_MESSAGES_STORE_FOR_TEST_KEY] = store;
  } else {
    delete globalStore[TELEGRAM_SENT_MESSAGES_STORE_FOR_TEST_KEY];
  }
}

export function listTelegramLegacySentMessageCacheEntries(params: {
  cfg?: Pick<OpenClawConfig, "session">;
  persistedPath?: string;
}): Array<{ key: string; value: PersistedSentMessage; ttlMs?: number }> {
  const scopeKey = resolveLegacySentMessageScopeKey(params.cfg);
  const filePath = params.persistedPath ?? resolveSentMessageStorePath(params.cfg);
  const legacy = fs.existsSync(filePath)
    ? readLegacySentMessages(filePath)
    : createSentMessageStore();
  return [...legacy.entries()].flatMap(([chatId, messages]) =>
    [...messages.entries()].map(([messageId, timestamp]) => ({
      key: sentMessageEntryKey(scopeKey, chatId, messageId),
      value: { scopeKey, chatId, messageId, timestamp },
      ttlMs: Math.max(1, TTL_MS - Math.max(0, Date.now() - timestamp)),
    })),
  );
}
