import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { EndReason } from "../../types.js";

const TERMINAL_PROVIDER_STATUS_TO_END_REASON: Record<string, EndReason> = {
  completed: "completed",
  failed: "failed",
  busy: "busy",
  "no-answer": "no-answer",
  canceled: "hangup-bot",
};

/** Normalizes provider status strings and preserves unknown/missing as "unknown". */
export function normalizeProviderStatus(status: string | null | undefined): string {
  const normalized = normalizeOptionalLowercaseString(status);
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

/** Maps terminal provider statuses to OpenClaw end reasons, leaving active states as null. */
export function mapProviderStatusToEndReason(status: string | null | undefined): EndReason | null {
  const normalized = normalizeProviderStatus(status);
  return TERMINAL_PROVIDER_STATUS_TO_END_REASON[normalized] ?? null;
}

/** Checks whether a provider status should end the local call record. */
export function isProviderStatusTerminal(status: string | null | undefined): boolean {
  return mapProviderStatusToEndReason(status) !== null;
}
