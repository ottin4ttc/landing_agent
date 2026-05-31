import path from "node:path";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { uniqueStrings } from "../../packages/normalization-core/src/string-normalization.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeAgentId } from "../routing/session-key.js";

export { loadCombinedSessionEntriesForGateway } from "../config/sessions/combined-session-entries-gateway.js";

const TRANSCRIPT_KEY_PREFIX = "transcript:";
const SESSION_ARCHIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/;
const QMD_ARCHIVE_STEM_RE = /^(.+)-jsonl-(reset|deleted)-(.+)$/;
const QMD_ARCHIVE_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})[tT](\d{2}-\d{2}-\d{2})(?:(?:\.|-)(\d{3}))?[zZ]$/;

export type SessionTranscriptHitIdentity = {
  stem: string;
  liveStem?: string;
  ownerAgentId?: string;
  archived: boolean;
};

function restoreQmdNormalizedArchiveTimestamp(timestamp: string): string | null {
  const match = QMD_ARCHIVE_TIMESTAMP_RE.exec(timestamp);
  if (!match) {
    return null;
  }
  const [, date, time, milliseconds] = match;
  return `${date}T${time}${milliseconds ? `.${milliseconds}` : ""}Z`;
}

function restoreQmdNormalizedArchiveName(mdStem: string): string | null {
  const match = QMD_ARCHIVE_STEM_RE.exec(mdStem);
  if (!match) {
    return null;
  }
  const [, sessionId, reason, timestamp] = match;
  const restoredTimestamp = restoreQmdNormalizedArchiveTimestamp(timestamp);
  return restoredTimestamp ? `${sessionId}.jsonl.${reason}.${restoredTimestamp}` : null;
}

function normalizeQmdSessionStem(stem: string): string {
  return stem
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hasUsageCountedArchiveSuffix(fileName: string, reason: "reset" | "deleted"): boolean {
  const marker = `.${reason}.`;
  const index = fileName.lastIndexOf(marker);
  if (index < 0) {
    return false;
  }
  return SESSION_ARCHIVE_TIMESTAMP_RE.test(fileName.slice(index + marker.length));
}

function parseUsageCountedSessionIdFromFileName(fileName: string): string | null {
  if (fileName.endsWith(".jsonl")) {
    return fileName.slice(0, -".jsonl".length);
  }
  for (const reason of ["reset", "deleted"] as const) {
    const marker = `.jsonl.${reason}.`;
    const index = fileName.lastIndexOf(marker);
    if (index > 0 && hasUsageCountedArchiveSuffix(fileName, reason)) {
      return fileName.slice(0, index);
    }
  }
  return null;
}

function parseTranscriptKey(hitPath: string): { base: string; ownerAgentId?: string } | null {
  if (!hitPath.startsWith(TRANSCRIPT_KEY_PREFIX)) {
    return null;
  }
  const parts = hitPath.slice(TRANSCRIPT_KEY_PREFIX.length).split(":");
  const agentId = parts.shift()?.trim();
  const sessionId = parts.join(":").trim();
  if (!agentId || !sessionId) {
    return null;
  }
  return { base: sessionId, ownerAgentId: normalizeAgentId(agentId) };
}

function parseSessionsPath(hitPath: string): { base: string; ownerAgentId?: string } | null {
  const transcriptKey = parseTranscriptKey(hitPath);
  if (transcriptKey) {
    return transcriptKey;
  }
  const normalized = hitPath.replace(/\\/g, "/");
  const fromSessionsRoot = normalized.startsWith("sessions/")
    ? normalized.slice("sessions/".length)
    : normalized;
  const parts = fromSessionsRoot.split("/").filter(Boolean);
  const base = path.posix.basename(fromSessionsRoot);
  const ownerAgentId =
    normalized.startsWith("sessions/") && parts.length === 2
      ? normalizeAgentId(parts[0])
      : undefined;
  return { base, ownerAgentId };
}

/**
 * Derive transcript stem `S` from a memory search hit key for `source === "sessions"`.
 * SQLite-backed hits use `transcript:<agent>:<session>`. Legacy/QMD paths are
 * still accepted so old QMD session collections remain visibility-gated.
 */
export function extractTranscriptStemFromSessionsMemoryHit(hitPath: string): string | null {
  return extractTranscriptIdentityFromSessionsMemoryHit(hitPath)?.stem ?? null;
}

export function extractTranscriptIdentityFromSessionsMemoryHit(
  hitPath: string,
): SessionTranscriptHitIdentity | null {
  const isQmdPath = hitPath.replace(/\\/g, "/").startsWith("qmd/");
  const parsed = parseSessionsPath(hitPath);
  if (!parsed) {
    return null;
  }
  const { base, ownerAgentId } = parsed;
  if (hitPath.startsWith(TRANSCRIPT_KEY_PREFIX)) {
    return { stem: base, ownerAgentId, archived: false };
  }
  const archivedStem = parseUsageCountedSessionIdFromFileName(base);
  if (archivedStem && base !== `${archivedStem}.jsonl`) {
    return { stem: archivedStem, ownerAgentId, archived: true };
  }
  if (base.endsWith(".jsonl")) {
    const stem = base.slice(0, -".jsonl".length);
    return stem ? { stem, ownerAgentId, archived: false } : null;
  }
  if (base.endsWith(".md")) {
    const mdStem = base.slice(0, -".md".length);
    if (!mdStem) {
      return null;
    }
    if (isQmdPath) {
      const exportedArchiveStem = parseUsageCountedSessionIdFromFileName(mdStem);
      if (exportedArchiveStem && mdStem !== `${exportedArchiveStem}.jsonl`) {
        return { stem: exportedArchiveStem, liveStem: mdStem, ownerAgentId, archived: true };
      }
      const restoredArchiveName = restoreQmdNormalizedArchiveName(mdStem);
      if (restoredArchiveName) {
        const normalizedArchiveStem = parseUsageCountedSessionIdFromFileName(restoredArchiveName);
        if (normalizedArchiveStem && restoredArchiveName !== `${normalizedArchiveStem}.jsonl`) {
          return { stem: normalizedArchiveStem, liveStem: mdStem, ownerAgentId, archived: true };
        }
      }
    }
    return { stem: mdStem, ownerAgentId, archived: false };
  }
  return null;
}

/**
 * Map transcript stem to canonical session row keys across all agents.
 * Session tools visibility and agent-to-agent policy are enforced by the caller.
 */
export function resolveTranscriptStemToSessionKeys(params: {
  entries: Record<string, SessionEntry>;
  stem: string;
  archivedOwnerAgentId?: string;
  allowQmdSlugFallback?: boolean;
}): string[] {
  const matches: string[] = [];
  const stemAsFile = params.stem.endsWith(".jsonl") ? params.stem : `${params.stem}.jsonl`;
  const parsedStemId = parseUsageCountedSessionIdFromFileName(stemAsFile);

  for (const [sessionKey, entry] of Object.entries(params.entries)) {
    if (entry.sessionId === params.stem || (parsedStemId && entry.sessionId === parsedStemId)) {
      matches.push(sessionKey);
    }
  }
  const deduped = uniqueStrings(matches);
  if (deduped.length > 0) {
    return deduped;
  }

  const normalizedStem = normalizeQmdSessionStem(params.stem);
  if (params.allowQmdSlugFallback === true && normalizedStem) {
    for (const [sessionKey, entry] of Object.entries(params.entries)) {
      if (normalizeQmdSessionStem(entry.sessionId) === normalizedStem) {
        matches.push(sessionKey);
      }
    }
  }
  const normalizedDeduped = uniqueStrings(matches);
  if (normalizedDeduped.length > 0) {
    return normalizedDeduped.length === 1 ? normalizedDeduped : [];
  }

  const archivedOwnerAgentId = normalizeOptionalString(params.archivedOwnerAgentId);
  return archivedOwnerAgentId
    ? [`agent:${normalizeAgentId(archivedOwnerAgentId)}:${params.stem}`]
    : [];
}
