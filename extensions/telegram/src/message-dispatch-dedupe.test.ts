import { randomUUID } from "node:crypto";
import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  buildTelegramMessageDispatchReplayKey,
  claimTelegramMessageDispatchReplay,
  commitTelegramMessageDispatchReplay,
  createTelegramMessageDispatchReplayGuard,
  releaseTelegramMessageDispatchReplay,
} from "./message-dispatch-dedupe.js";

function createScopeKey(): string {
  return `test-${randomUUID()}`;
}

function message(params?: { chatId?: number; messageId?: number }): Message {
  return {
    message_id: params?.messageId ?? 42,
    date: 1736380800,
    chat: { id: params?.chatId ?? 1234, type: "private" },
  } as Message;
}

describe("Telegram message dispatch replay guard", () => {
  it("keys messages by chat id and message id", () => {
    expect(buildTelegramMessageDispatchReplayKey(message())).toBe(
      JSON.stringify(["message", "1234", 42]),
    );
    expect(buildTelegramMessageDispatchReplayKey(message({ messageId: 0 }))).toBeNull();
  });

  it("persists committed dispatches across guard recreation", async () => {
    const scopeKey = createScopeKey();
    const writer = createTelegramMessageDispatchReplayGuard({ scopeKey });
    const first = await claimTelegramMessageDispatchReplay({
      guard: writer,
      accountId: "default",
      msg: message(),
    });

    expect(first).toEqual({
      kind: "claimed",
      key: JSON.stringify(["message", "1234", 42]),
    });
    if (first.kind !== "claimed") {
      throw new Error("expected initial claim");
    }
    await commitTelegramMessageDispatchReplay({
      guard: writer,
      accountId: "default",
      keys: [first.key],
    });

    const reader = createTelegramMessageDispatchReplayGuard({ scopeKey });
    await expect(
      claimTelegramMessageDispatchReplay({
        guard: reader,
        accountId: "default",
        msg: message(),
      }),
    ).resolves.toEqual({ kind: "duplicate" });
  });

  it("keeps accounts isolated and releases retryable pre-dispatch claims", async () => {
    const guard = createTelegramMessageDispatchReplayGuard({ scopeKey: createScopeKey() });
    const first = await claimTelegramMessageDispatchReplay({
      guard,
      accountId: "default",
      msg: message(),
    });
    if (first.kind !== "claimed") {
      throw new Error("expected initial claim");
    }

    await expect(
      claimTelegramMessageDispatchReplay({
        guard,
        accountId: "work",
        msg: message(),
      }),
    ).resolves.toEqual({
      kind: "claimed",
      key: first.key,
    });

    releaseTelegramMessageDispatchReplay({
      guard,
      accountId: "default",
      keys: [first.key],
    });
    await expect(
      claimTelegramMessageDispatchReplay({
        guard,
        accountId: "default",
        msg: message(),
      }),
    ).resolves.toEqual({
      kind: "claimed",
      key: first.key,
    });
  });
});
