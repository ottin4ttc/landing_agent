import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";

type SessionLock = {
  release(): Promise<void>;
};

type SessionWriteLockRunOptions = {
  publishOwnedWrite?: boolean;
};

type SessionWithAgentPrompt = {
  agent?: {
    streamFn?: PromptReleaseStreamFn;
  };
};

type PromptReleaseStreamFn = ((...args: unknown[]) => unknown) & {
  __openclawSessionLockPromptReleaseInstalled?: boolean;
};

export class EmbeddedAttemptSessionTakeoverError extends Error {
  constructor(sessionRef?: string) {
    super(
      sessionRef
        ? `session changed while embedded prompt lock was released: ${sessionRef}`
        : "session changed while embedded prompt lock was released",
    );
    this.name = "EmbeddedAttemptSessionTakeoverError";
  }
}

export type EmbeddedAttemptSessionLockController = {
  releaseForPrompt(): Promise<void>;
  releaseHeldLockForAbort(): Promise<void>;
  refreshAfterOwnedSessionWrite(): void;
  reacquireAfterPrompt(): Promise<void>;
  waitForSessionEvents(session: unknown): Promise<void>;
  withSessionWriteLock<T>(
    run: () => Promise<T> | T,
    options?: SessionWriteLockRunOptions,
  ): Promise<T>;
  acquireForCleanup(params?: { session?: unknown }): Promise<SessionLock>;
  hasSessionTakeover(): boolean;
  dispose(): Promise<void>;
};

export function installPromptSubmissionLockRelease(params: {
  session: unknown;
  waitForSessionEvents: (session: unknown) => Promise<void>;
  releaseForPrompt: () => Promise<void>;
  reacquireAfterPrompt: () => Promise<void>;
  sessionKey?: string;
  withSessionWriteLock?: <T>(
    run: () => Promise<T> | T,
    options?: SessionWriteLockRunOptions,
  ) => Promise<T>;
}): void {
  const agent = (params.session as SessionWithAgentPrompt).agent;
  if (typeof agent?.streamFn !== "function") {
    return;
  }
  const currentStreamFn = agent.streamFn;
  if (currentStreamFn["__openclawSessionLockPromptReleaseInstalled"] === true) {
    return;
  }
  const originalStreamFn = currentStreamFn.bind(agent);
  const wrappedStreamFn: PromptReleaseStreamFn = async (...args: unknown[]) => {
    await params.waitForSessionEvents(params.session);
    await params.releaseForPrompt();
    try {
      if (params.sessionKey && params.withSessionWriteLock) {
        return await withOwnedSessionTranscriptWrites(
          {
            sessionKey: params.sessionKey,
            withSessionWriteLock: params.withSessionWriteLock,
          },
          async () => await originalStreamFn(...args),
        );
      }
      return await originalStreamFn(...args);
    } finally {
      await params.waitForSessionEvents(params.session);
      await params.reacquireAfterPrompt();
    }
  };
  wrappedStreamFn["__openclawSessionLockPromptReleaseInstalled"] = true;
  agent.streamFn = wrappedStreamFn;
}
