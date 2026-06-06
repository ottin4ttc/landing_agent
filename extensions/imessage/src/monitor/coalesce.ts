// Imessage plugin module implements coalesce behavior.
import type { IMessagePayload } from "./types.js";

// Keep the coalescing contract narrow (caps, ID tracking, reply-context
// preference) so a future SDK lift into `openclaw/plugin-sdk/channel-inbound`
// is a mechanical extraction instead of a behavioral redesign. Apple's
// split-send pipeline is the behavior this protects.

/**
 * Bounds on the merged output when multiple inbound iMessage payloads are
 * folded into one agent turn. Caps each merge so a sender who
 * rapid-fires DMs inside the debounce window cannot amplify the downstream
 * prompt past a safe ceiling. Every source GUID still surfaces via
 * `coalescedMessageGuids` so a future replay path can recognize duplicates.
 */
export const MAX_COALESCED_TEXT_CHARS = 4000;
export const MAX_COALESCED_ATTACHMENTS = 20;
export const MAX_COALESCED_ENTRIES = 10;

/**
 * Longest text (in whitespace-delimited words) still treated as a split
 * lead-in. Apple peels short command fragments — `Dump`, `Save this`,
 * `look at` — off the front of a `<command> <payload>` send; anything longer
 * reads as a self-contained message and dispatches instantly.
 */
export const LEAD_IN_MAX_WORDS = 3;

const URL_PATTERN = /\bhttps?:\/\/\S+/i;

/** True when the text carries an http(s) URL — the typical split-send payload. */
export function iMessageTextHasUrl(text: string | null | undefined): boolean {
  return URL_PATTERN.test(text ?? "");
}

/**
 * A "split lead-in" is the short text fragment Apple delivers as its own
 * `chat.db` row just before the payload row of a `<command> <URL/attachment>`
 * send (e.g. `Dump` ahead of `https://…`, or a bare caption typed just before
 * an image). It is the ONLY DM shape the monitor holds back to wait for a
 * follow-up; every other shape dispatches instantly so normal conversation
 * carries zero added latency.
 *
 * Heuristic: non-empty short text (≤ {@link LEAD_IN_MAX_WORDS} words), no URL,
 * no media, and no terminal sentence punctuation. The dangling, unpunctuated
 * shape is what separates a lead-in (`Dump`) from a complete one-liner
 * (`what's for dinner?`). The cost of a false positive is bounded: a lone
 * short fragment with no follow-up still flushes after the coalesce window.
 */
export function isIMessageSplitLeadIn(params: {
  text: string | null | undefined;
  hasMedia: boolean;
}): boolean {
  if (params.hasMedia) {
    return false;
  }
  const text = (params.text ?? "").trim();
  if (!text) {
    return false;
  }
  if (iMessageTextHasUrl(text)) {
    return false;
  }
  if (/[.?!…]$/.test(text)) {
    return false;
  }
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= LEAD_IN_MAX_WORDS;
}

export type CoalescedIMessagePayload = IMessagePayload & {
  /**
   * Source GUIDs folded into this merged payload, in arrival order. Includes
   * GUIDs from entries that were dropped by the entry cap so downstream
   * dedupe paths can still recognize them.
   */
  coalescedMessageGuids?: string[];
  coalescedCatchupCursor?: {
    lastSeenMs: number;
    lastSeenRowid: number;
  };
};

/**
 * Combine consecutive same-sender iMessage payloads into a single payload for
 * downstream dispatch. Used when the debouncer flushes a bucket containing
 * more than one event — e.g. Apple's split-send for `Dump https://example.com`
 * arriving as two separate `chat.db` rows ~0.8-2.0 s apart.
 *
 * The first payload anchors the merged shape (preserving its GUID for reply
 * threading). Text is concatenated with deduplication, attachments are merged
 * (capped), and the latest `created_at` wins so downstream sees the most
 * recent activity timestamp.
 */
export function combineIMessagePayloads(payloads: IMessagePayload[]): CoalescedIMessagePayload {
  if (payloads.length === 0) {
    throw new Error("combineIMessagePayloads: cannot combine empty payloads");
  }
  if (payloads.length === 1) {
    return payloads[0];
  }

  const first = payloads[0];
  const last = payloads[payloads.length - 1];

  // Cap entries: keep first (preserves command/context) + most recent
  // (preserves latest payload) when a flood exceeds the cap.
  const boundedPayloads =
    payloads.length > MAX_COALESCED_ENTRIES
      ? [...payloads.slice(0, MAX_COALESCED_ENTRIES - 1), last]
      : payloads;

  // Combine text across bounded entries. Skip duplicates so a URL appearing
  // both as plain text and as a separately-rendered link-preview row does not
  // get repeated in the merged prompt.
  const seenTexts = new Set<string>();
  const textParts: string[] = [];
  for (const payload of boundedPayloads) {
    const text = (payload.text ?? "").trim();
    if (!text) {
      continue;
    }
    const normalized = text.toLowerCase();
    if (seenTexts.has(normalized)) {
      continue;
    }
    seenTexts.add(normalized);
    textParts.push(text);
  }
  let combinedText = textParts.join(" ");
  if (combinedText.length > MAX_COALESCED_TEXT_CHARS) {
    combinedText = `${combinedText.slice(0, MAX_COALESCED_TEXT_CHARS)}…[truncated]`;
  }

  // Merge attachments across bounded entries, capped to keep downstream media
  // fan-out proportional to a single message.
  const allAttachments = boundedPayloads
    .flatMap((p) => p.attachments ?? [])
    .slice(0, MAX_COALESCED_ATTACHMENTS);

  // Latest `created_at` (lexically max ISO-8601 string) so downstream sees
  // the freshest activity timestamp. Falls back to `first.created_at` if no
  // entries carry a usable timestamp.
  const createdAts = payloads
    .map((p) => p.created_at)
    .filter((c): c is string => typeof c === "string" && c.length > 0);
  const latestCreatedAt =
    createdAts.length > 0 ? createdAts.reduce((a, b) => (a > b ? a : b)) : first.created_at;

  let maxRowid = -Infinity;
  let maxDateMs = -Infinity;
  for (const payload of payloads) {
    if (typeof payload.id === "number" && Number.isFinite(payload.id)) {
      maxRowid = Math.max(maxRowid, payload.id);
    }
    const dateMs =
      typeof payload.created_at === "string" ? Date.parse(payload.created_at) : Number.NaN;
    if (Number.isFinite(dateMs)) {
      maxDateMs = Math.max(maxDateMs, dateMs);
    }
  }

  // Walk the unbounded `payloads` so even GUIDs whose text/attachments were
  // dropped by the cap are still remembered for downstream dedupe.
  const seenGuids = new Set<string>();
  const coalescedMessageGuids: string[] = [];
  for (const payload of payloads) {
    const guid = payload.guid?.trim();
    if (!guid || seenGuids.has(guid)) {
      continue;
    }
    seenGuids.add(guid);
    coalescedMessageGuids.push(guid);
  }

  // Reply context: prefer any entry that carries one; the last balloon in a
  // split-send rarely does, but a manual quote-reply earlier in the bucket
  // might.
  const entryWithReply = payloads.find((p) => p.reply_to_id != null);

  return {
    ...first,
    text: combinedText,
    attachments: allAttachments.length > 0 ? allAttachments : null,
    created_at: latestCreatedAt,
    reply_to_id: entryWithReply?.reply_to_id ?? first.reply_to_id ?? null,
    reply_to_text: entryWithReply?.reply_to_text ?? first.reply_to_text ?? null,
    reply_to_sender: entryWithReply?.reply_to_sender ?? first.reply_to_sender ?? null,
    coalescedMessageGuids: coalescedMessageGuids.length > 0 ? coalescedMessageGuids : undefined,
    coalescedCatchupCursor:
      Number.isFinite(maxRowid) && Number.isFinite(maxDateMs)
        ? { lastSeenMs: maxDateMs, lastSeenRowid: maxRowid }
        : undefined,
  };
}
