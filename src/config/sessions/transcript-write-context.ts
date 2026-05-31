import { AsyncLocalStorage } from "node:async_hooks";

type OwnedSessionTranscriptWriteContext = {
  sessionKey?: string;
  withSessionWriteLock: <T>(
    run: () => Promise<T> | T,
    options?: { publishOwnedWrite?: boolean },
  ) => Promise<T>;
};

const ownedTranscriptWriteContext = new AsyncLocalStorage<OwnedSessionTranscriptWriteContext>();

function contextMatches(params: {
  context: OwnedSessionTranscriptWriteContext;
  sessionKey?: string;
}): boolean {
  const contextSessionKey = params.context.sessionKey?.trim();
  const sessionKey = params.sessionKey?.trim();
  return Boolean(contextSessionKey && sessionKey && contextSessionKey === sessionKey);
}

export async function withOwnedSessionTranscriptWrites<T>(
  context: OwnedSessionTranscriptWriteContext,
  run: () => Promise<T>,
): Promise<T> {
  return await ownedTranscriptWriteContext.run(context, run);
}

export function bindOwnedSessionTranscriptWrites<TArgs extends unknown[], TResult>(
  context: OwnedSessionTranscriptWriteContext,
  run: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return (...args) => ownedTranscriptWriteContext.run(context, () => run(...args));
}

export async function runWithOwnedSessionTranscriptWriteLock<T>(
  params: {
    sessionKey?: string;
  },
  run: () => Promise<T> | T,
): Promise<T> {
  return await runWithOwnedSessionTranscriptWriteContext(params, run);
}

export async function runWithOwnedSessionTranscriptWritePublication<T>(
  params: {
    sessionKey?: string;
  },
  run: () => Promise<T> | T,
): Promise<T> {
  return await runWithOwnedSessionTranscriptWriteContext(params, run, {
    publishOwnedWrite: true,
  });
}

export function resolveOwnedSessionTranscriptWriteLockRunner(params: {
  sessionKey?: string;
}): OwnedSessionTranscriptWriteContext["withSessionWriteLock"] | undefined {
  const context = ownedTranscriptWriteContext.getStore();
  if (!context || !contextMatches({ context, ...params })) {
    return undefined;
  }
  return context.withSessionWriteLock;
}

async function runWithOwnedSessionTranscriptWriteContext<T>(
  params: {
    sessionKey?: string;
  },
  run: () => Promise<T> | T,
  options?: { publishOwnedWrite?: boolean },
): Promise<T> {
  const context = ownedTranscriptWriteContext.getStore();
  if (!context || !contextMatches({ context, ...params })) {
    return await run();
  }
  return await context.withSessionWriteLock(run, options);
}
