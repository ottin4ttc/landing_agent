// Qwen plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createPayloadPatchStreamWrapper,
  isOpenAICompatibleThinkingEnabled,
} from "openclaw/plugin-sdk/provider-stream-shared";

type QwenThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
type QwenThinkingFormat = string | undefined;

function isQwenProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return (
    normalized === "qwen" ||
    normalized === "qwen-oauth" ||
    normalized === "qwen-portal" ||
    normalized === "qwen-cli" ||
    normalized === "modelstudio" ||
    normalized === "qwencloud" ||
    normalized === "dashscope"
  );
}

function isQwenOAuthProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return normalized === "qwen-oauth" || normalized === "qwen-portal" || normalized === "qwen-cli";
}

function normalizeQwenOAuthContent(content: unknown): unknown {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return content;
  }
  const normalized = content
    .map((part) => {
      if (typeof part === "string") {
        return { type: "text", text: part };
      }
      return part && typeof part === "object" ? part : undefined;
    })
    .filter((part): part is Record<string, unknown> => Boolean(part));
  return normalized.length > 0 ? normalized : content;
}

type PayloadFieldRead = { ok: true; value: unknown } | { ok: false };

function readPayloadField(record: Record<string, unknown>, key: string): PayloadFieldRead {
  try {
    return { ok: true, value: record[key] };
  } catch {
    return { ok: false };
  }
}

function forcePayloadField(record: Record<string, unknown>, key: string, value: unknown): boolean {
  try {
    Object.defineProperty(record, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    const next = readPayloadField(record, key);
    return next.ok && next.value === value;
  } catch {
    return false;
  }
}

function deletePayloadField(record: Record<string, unknown>, key: string): boolean {
  try {
    delete record[key];
    return !Object.hasOwn(record, key);
  } catch {
    return false;
  }
}

function copyPlainDataFields(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) {
      copy[key] = descriptor.value;
    }
  }
  return copy;
}

function patchQwenOAuthPayload(payload: Record<string, unknown>): void {
  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    record.content = normalizeQwenOAuthContent(record.content);
    if (record.role !== "system" || !Array.isArray(record.content) || record.content.length === 0) {
      continue;
    }
    const last = record.content[record.content.length - 1];
    if (last && typeof last === "object") {
      (last as Record<string, unknown>).cache_control = { type: "ephemeral" };
    }
  }
  payload.vl_high_resolution_images = true;
}

function setQwenChatTemplateThinking(payload: Record<string, unknown>, enabled: boolean): void {
  const existing = readPayloadField(payload, "chat_template_kwargs");
  let next: Record<string, unknown>;
  if (
    existing.ok &&
    existing.value &&
    typeof existing.value === "object" &&
    !Array.isArray(existing.value)
  ) {
    next = copyPlainDataFields(existing.value as Record<string, unknown>);
  } else {
    next = {};
  }
  next.enable_thinking = enabled;
  if (!Object.hasOwn(next, "preserve_thinking")) {
    next.preserve_thinking = true;
  }
  if (!forcePayloadField(payload, "chat_template_kwargs", next)) {
    throw new Error("Qwen chat template payload patch failed");
  }
}

function removeQwenPayloadField(payload: Record<string, unknown>, key: string): void {
  if (!deletePayloadField(payload, key)) {
    throw new Error(`Qwen payload field could not be removed: ${key}`);
  }
}

function readQwenThinkingFormatFromModel(model: Parameters<StreamFn>[0]): QwenThinkingFormat {
  if (model.api !== "openai-completions") {
    return undefined;
  }
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as { thinkingFormat?: unknown })
      : undefined;
  return typeof compat?.thinkingFormat === "string" ? compat.thinkingFormat : undefined;
}

export function createQwenThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel: QwenThinkingLevel,
  thinkingFormat?: QwenThinkingFormat,
): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload: payloadObj, model, options }) => {
      const enableThinking = isOpenAICompatibleThinkingEnabled({ thinkingLevel, options });
      const effectiveThinkingFormat = thinkingFormat ?? readQwenThinkingFormatFromModel(model);
      if (effectiveThinkingFormat === "qwen-chat-template") {
        setQwenChatTemplateThinking(payloadObj, enableThinking);
        removeQwenPayloadField(payloadObj, "enable_thinking");
      } else if (!forcePayloadField(payloadObj, "enable_thinking", enableThinking)) {
        throw new Error("Qwen enable_thinking payload patch failed");
      }
      removeQwenPayloadField(payloadObj, "reasoning_effort");
      removeQwenPayloadField(payloadObj, "reasoningEffort");
      removeQwenPayloadField(payloadObj, "reasoning");
    },
    {
      shouldPatch: ({ model }) => model.api === "openai-completions" && model.reasoning,
    },
  );
}

export function wrapQwenProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  if (!isQwenProviderId(ctx.provider) || (ctx.model && ctx.model.api !== "openai-completions")) {
    return undefined;
  }
  const streamFn = createQwenThinkingWrapper(
    ctx.streamFn,
    ctx.thinkingLevel,
    ctx.model ? readQwenThinkingFormatFromModel(ctx.model) : undefined,
  );
  if (!isQwenOAuthProviderId(ctx.provider)) {
    return streamFn;
  }
  return createPayloadPatchStreamWrapper(streamFn, ({ payload, model }) => {
    if (model.api === "openai-completions") {
      patchQwenOAuthPayload(payload);
    }
  });
}
