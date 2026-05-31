import { randomUUID } from "node:crypto";
import {
  listSqliteSessionTranscripts,
  loadSqliteSessionTranscriptEvents,
} from "../../config/sessions/transcript-store.sqlite.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import {
  buildSessionContext as buildCoreSessionContext,
  CURRENT_SESSION_VERSION,
} from "../transcript/session-transcript-contract.js";
import type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  LabelEntry,
  ModelChangeEntry,
  SessionContext,
  SessionEntry,
  SessionEntryBase,
  SessionHeader as TranscriptSessionHeader,
  SessionInfoEntry,
  SessionMessageEntry,
  SessionTranscriptScope,
  SessionTreeNode,
  ThinkingLevelChangeEntry,
  TranscriptEntry,
} from "../transcript/session-transcript-contract.js";
import {
  loadOrCreateTranscriptStateForSession,
  replaceTranscriptStateForSession,
  type TranscriptState,
} from "../transcript/transcript-persistence.js";
import { transcriptStateFromEntries } from "../transcript/transcript-state.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";

export { CURRENT_SESSION_VERSION };
export type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  LabelEntry,
  ModelChangeEntry,
  SessionContext,
  SessionEntry,
  SessionEntryBase,
  SessionInfoEntry,
  SessionMessageEntry,
  SessionTreeNode,
  ThinkingLevelChangeEntry,
};

export interface SessionHeader extends TranscriptSessionHeader {
  parentTranscriptScope?: SessionTranscriptScope;
}

export interface NewSessionOptions {
  id?: string;
  parentTranscriptScope?: SessionTranscriptScope;
}

export type FileEntry = TranscriptEntry;

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentTranscriptScope?: SessionTranscriptScope;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}

export type ReadonlySessionManager = Pick<
  SessionManager,
  | "getCwd"
  | "getSessionDir"
  | "getSessionId"
  | "getSessionRef"
  | "getLeafId"
  | "getLeafEntry"
  | "getEntry"
  | "getLabel"
  | "getBranch"
  | "getHeader"
  | "getEntries"
  | "getTree"
  | "getSessionName"
  | "getTranscriptScope"
>;

export type SessionListProgress = (loaded: number, total: number) => void;

type PersistableMessage = Parameters<TranscriptState["appendMessage"]>[0];

function createSessionId(): string {
  return randomUUID();
}

function createTranscriptHeader(params: {
  cwd: string;
  id: string;
  parentTranscriptScope?: SessionTranscriptScope;
}): SessionHeader {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.id,
    timestamp: new Date().toISOString(),
    cwd: params.cwd,
    ...(params.parentTranscriptScope
      ? { parentTranscriptScope: params.parentTranscriptScope }
      : {}),
  };
}

function normalizeSessionRef(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function transcriptRef(scope: SessionTranscriptScope): string {
  return `transcript:${scope.agentId}:${scope.sessionId}`;
}

function parseTextContent(message: unknown): string {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join(" ");
}

function stateToSessionInfo(scope: SessionTranscriptScope, state: TranscriptState): SessionInfo {
  const header = state.getHeader();
  const entries = state.getEntries();
  const messages = entries.filter(
    (entry): entry is SessionMessageEntry => entry.type === "message",
  );
  const humanMessages = messages
    .filter((entry) => entry.message.role === "user" || entry.message.role === "assistant")
    .map((entry) => ({
      role: entry.message.role,
      text: parseTextContent(entry.message),
    }))
    .filter((entry) => entry.text.trim());
  const firstUser = humanMessages.find((entry) => entry.role === "user")?.text;
  const timestamps = [header?.timestamp, ...entries.map((entry) => entry.timestamp)].flatMap(
    (value) => {
      const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
      return Number.isFinite(parsed) ? [parsed] : [];
    },
  );
  const created = header?.timestamp ? new Date(header.timestamp) : new Date(0);
  const modified = new Date(timestamps.length > 0 ? Math.max(...timestamps) : created.getTime());
  return {
    path: transcriptRef(scope),
    id: scope.sessionId,
    cwd: header?.cwd ?? "",
    name: state.getSessionName(),
    parentTranscriptScope: header?.parentTranscriptScope,
    created,
    modified,
    messageCount: messages.length,
    firstMessage: firstUser || "(no messages)",
    allMessagesText: humanMessages.map((entry) => entry.text).join(" "),
  };
}

function loadTranscriptState(scope: SessionTranscriptScope): TranscriptState {
  const events = loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
  return transcriptStateFromEntries(
    events.filter((event): event is TranscriptEntry => Boolean(event && typeof event === "object")),
  );
}

/**
 * Build an OpenClaw agent session context from transcript entries.
 */
export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  byId?: Map<string, SessionEntry>,
): SessionContext {
  return buildCoreSessionContext(entries, leafId, byId);
}

/**
 * Return the newest compaction entry from a transcript entry list.
 */
export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "compaction") {
      return entry;
    }
  }
  return null;
}

/**
 * Compute the legacy session directory label for callers that still display it.
 */
export function getDefaultSessionDir(_cwd: string, agentDir = DEFAULT_AGENT_ID): string {
  return `sqlite:${agentDir}`;
}

/**
 * Manages the OpenClaw-owned interactive transcript on top of SQLite.
 */
export class SessionManager {
  private state: TranscriptState;
  private readonly persist: boolean;
  private readonly sessionDir: string;
  private scope?: SessionTranscriptScope;
  private explicitBranchSelection = false;

  private constructor(params: {
    cwd: string;
    sessionDir: string;
    persist: boolean;
    scope?: SessionTranscriptScope;
    state?: TranscriptState;
  }) {
    this.persist = params.persist;
    this.sessionDir = params.sessionDir;
    if (params.state) {
      this.state = params.state;
      this.scope = params.scope;
      return;
    }
    const id = params.scope?.sessionId ?? createSessionId();
    const header = createTranscriptHeader({ cwd: params.cwd, id });
    this.state = transcriptStateFromEntries([header]);
    this.scope = params.scope;
    this.persistFullState();
  }

  /**
   * Create a persisted SQLite transcript for a working directory.
   */
  static createForCwd(cwd: string, sessionDir?: string): SessionManager {
    const sessionId = createSessionId();
    const loaded = loadOrCreateTranscriptStateForSession({
      agentId: DEFAULT_AGENT_ID,
      sessionId,
      cwd,
    });
    return new SessionManager({
      cwd,
      sessionDir: sessionDir ?? getDefaultSessionDir(cwd),
      persist: true,
      scope: loaded.scope,
      state: loaded.state,
    });
  }

  /**
   * Resume a persisted SQLite transcript by session id or transcript ref.
   */
  static resumeTranscript(ref: string, sessionDir?: string, cwdOverride?: string): SessionManager {
    const sessionId = normalizeSessionRef(ref.split(":").at(-1), ref);
    const loaded = loadOrCreateTranscriptStateForSession({
      agentId: DEFAULT_AGENT_ID,
      sessionId,
      ...(cwdOverride ? { cwd: cwdOverride } : {}),
    });
    return new SessionManager({
      cwd: cwdOverride ?? loaded.state.getCwd(),
      sessionDir: sessionDir ?? getDefaultSessionDir(cwdOverride ?? loaded.state.getCwd()),
      persist: true,
      scope: loaded.scope,
      state: loaded.state,
    });
  }

  /**
   * Continue the most recently updated SQLite transcript, or create a new one.
   */
  static continueRecentForCwd(cwd: string, sessionDir?: string): SessionManager {
    const recent = listSqliteSessionTranscripts({ agentId: DEFAULT_AGENT_ID })[0];
    if (!recent) {
      return SessionManager.createForCwd(cwd, sessionDir);
    }
    return SessionManager.resumeTranscript(recent.sessionId, sessionDir, cwd);
  }

  /**
   * Create an in-memory transcript for tests and non-persisted runtimes.
   */
  static inMemory(cwd: string = process.cwd()): SessionManager {
    return new SessionManager({
      cwd,
      sessionDir: "",
      persist: false,
      state: transcriptStateFromEntries([createTranscriptHeader({ cwd, id: createSessionId() })]),
    });
  }

  /**
   * List SQLite transcripts as session rows for the interactive runtime.
   */
  static async listForCwd(
    _cwd: string,
    _sessionDir?: string,
    onProgress?: SessionListProgress,
  ): Promise<SessionInfo[]> {
    return SessionManager.listAllSqlite(onProgress);
  }

  /**
   * List every registered SQLite transcript.
   */
  static async listAllSqlite(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
    const transcripts = listSqliteSessionTranscripts({ agentId: DEFAULT_AGENT_ID });
    const sessions: SessionInfo[] = [];
    let loaded = 0;
    for (const scope of transcripts) {
      try {
        sessions.push(stateToSessionInfo(scope, loadTranscriptState(scope)));
      } finally {
        loaded += 1;
        onProgress?.(loaded, transcripts.length);
      }
    }
    return sessions.toSorted((a, b) => b.modified.getTime() - a.modified.getTime());
  }

  isPersisted(): boolean {
    return this.persist;
  }

  getCwd(): string {
    return this.state.getCwd();
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getSessionId(): string {
    return this.state.getHeader()?.id ?? this.scope?.sessionId ?? "";
  }

  getSessionRef(): string | undefined {
    return this.scope ? transcriptRef(this.scope) : undefined;
  }

  getTranscriptScope(): SessionTranscriptScope | undefined {
    return this.scope ? { ...this.scope } : undefined;
  }

  newSession(options?: NewSessionOptions): string | undefined {
    const sessionId = options?.id ?? createSessionId();
    this.state = transcriptStateFromEntries([
      createTranscriptHeader({
        cwd: this.getCwd(),
        id: sessionId,
        ...(options?.parentTranscriptScope
          ? { parentTranscriptScope: options.parentTranscriptScope }
          : {}),
      }),
    ]);
    this.scope = this.persist ? { agentId: DEFAULT_AGENT_ID, sessionId } : undefined;
    this.explicitBranchSelection = false;
    this.persistFullState();
    return this.getSessionRef();
  }

  appendMessage(message: PersistableMessage | CustomMessage | BashExecutionMessage): string {
    const entry = this.state.appendMessage(message);
    this.persistMutation([entry]);
    return entry.id;
  }

  appendThinkingLevelChange(thinkingLevel: string): string {
    const entry = this.state.appendThinkingLevelChange(thinkingLevel);
    this.persistMutation([entry]);
    return entry.id;
  }

  appendModelChange(provider: string, modelId: string): string {
    const entry = this.state.appendModelChange(provider, modelId);
    this.persistMutation([entry]);
    return entry.id;
  }

  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    const entry = this.state.appendCompaction(
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
    );
    this.persistMutation([entry]);
    return entry.id;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entry = this.state.appendCustomEntry(customType, data);
    this.persistMutation([entry]);
    return entry.id;
  }

  appendSessionInfo(name: string): string {
    const entry = this.state.appendSessionInfo(name);
    this.persistMutation([entry]);
    return entry.id;
  }

  getSessionName(): string | undefined {
    return this.state.getSessionName();
  }

  appendCustomMessageEntry(
    customType: string,
    content: CustomMessageEntry["content"],
    display: boolean,
    details?: unknown,
  ): string {
    const entry = this.state.appendCustomMessageEntry(customType, content, display, details);
    this.persistMutation([entry]);
    return entry.id;
  }

  getLeafId(): string | null {
    return this.state.getLeafId();
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.state.getLeafEntry();
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.state.getEntry(id);
  }

  getChildren(parentId: string): SessionEntry[] {
    return this.state.getChildren(parentId);
  }

  getLabel(id: string): string | undefined {
    return this.state.getLabel(id);
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    const entry = this.state.appendLabelChange(targetId, label);
    this.persistMutation([entry]);
    return entry.id;
  }

  getBranch(fromId?: string): SessionEntry[] {
    return this.state.getBranch(fromId);
  }

  buildSessionContext(): SessionContext {
    return this.state.buildSessionContext();
  }

  getHeader(): SessionHeader | null {
    return this.state.getHeader();
  }

  getEntries(): SessionEntry[] {
    return this.state.getEntries();
  }

  getTree(): SessionTreeNode[] {
    return this.state.getTree();
  }

  branch(branchFromId: string): void {
    this.state.branch(branchFromId);
    this.explicitBranchSelection = true;
  }

  resetLeaf(): void {
    this.state.resetLeaf();
    this.explicitBranchSelection = true;
  }

  removeTailEntries(
    shouldRemove: (entry: SessionEntry) => boolean,
    options?: { maxEntries?: number; minEntries?: number },
  ): number {
    const removed = this.state.removeTailEntries(shouldRemove, options);
    if (removed > 0) {
      this.explicitBranchSelection = false;
      this.persistFullState();
    }
    return removed;
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    const entry = this.state.branchWithSummary(branchFromId, summary, details, fromHook);
    this.persistMutation([entry], { replace: this.explicitBranchSelection });
    return entry.id;
  }

  createBranchedTranscript(leafId: string): string | undefined {
    const branch = this.state.getBranch(leafId);
    if (branch.length === 0) {
      throw new Error(`Entry ${leafId} not found`);
    }
    const sourceScope = this.getTranscriptScope();
    const nextId = createSessionId();
    const header = createTranscriptHeader({
      cwd: this.getCwd(),
      id: nextId,
      ...(sourceScope ? { parentTranscriptScope: sourceScope } : {}),
    });
    const pathIds = new Set(branch.map((entry) => entry.id));
    const labels = this.state
      .getEntries()
      .filter(
        (entry): entry is LabelEntry => entry.type === "label" && pathIds.has(entry.targetId),
      );
    this.state = transcriptStateFromEntries([header, ...branch, ...labels]);
    this.scope = this.persist ? { agentId: DEFAULT_AGENT_ID, sessionId: nextId } : undefined;
    this.explicitBranchSelection = false;
    this.persistFullState();
    return this.getSessionRef();
  }

  private persistMutation(_entries: SessionEntry[], options?: { replace?: boolean }): void {
    if (!this.persist || !this.scope) {
      return;
    }
    if (options?.replace || this.explicitBranchSelection) {
      this.persistFullState();
      return;
    }
    replaceTranscriptStateForSession({ scope: this.scope, state: this.state });
  }

  private persistFullState(): void {
    if (!this.persist || !this.scope) {
      return;
    }
    replaceTranscriptStateForSession({ scope: this.scope, state: this.state });
  }
}
