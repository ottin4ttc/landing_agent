import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { validateSessionId } from "./paths.js";
import type { SessionEntry } from "./types.js";

function isSafeSessionId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 255) {
    return false;
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    return false;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(trimmed);
}

function normalizeTranscriptSessionId(value: string): string | undefined {
  try {
    return validateSessionId(value);
  } catch {
    return undefined;
  }
}

function normalizeOptionalTimestamp(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function normalizePersistedSessionEntryShape(value: unknown): SessionEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  let next = value as unknown as SessionEntry;
  if (value.sessionId !== undefined) {
    if (!isSafeSessionId(value.sessionId)) {
      return undefined;
    }
    const sessionId = value.sessionId.trim();
    const transcriptSessionId = normalizeTranscriptSessionId(sessionId);
    // SQLite transcripts are keyed solely by sessionId; without a usable
    // transcript session id there is no file fallback, so drop the id.
    if (!transcriptSessionId) {
      const { sessionId: _dropSessionId, ...rest } = next;
      next = rest as SessionEntry;
    } else if (sessionId !== value.sessionId) {
      next = { ...next, sessionId };
    }
  }

  const updatedAt = normalizeOptionalTimestamp(value.updatedAt);
  if (updatedAt !== value.updatedAt) {
    if (next === value) {
      next = { ...next };
    }
    next.updatedAt = updatedAt ?? 0;
  }

  return next;
}
