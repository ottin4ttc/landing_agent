// Docker command timeout tests cover hung Docker CLI processes that start but
// never emit close, which can otherwise stall sandbox initialization forever.
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockDockerChild = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: { end: (input?: string | Buffer) => void };
  kill: (signal?: NodeJS.Signals) => void;
};

const spawnState = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  kills: [] as Array<NodeJS.Signals | undefined>,
}));

function createHungDockerChild(): MockDockerChild {
  const child = new EventEmitter() as MockDockerChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = { end: () => undefined };
  child.kill = (signal?: NodeJS.Signals) => {
    spawnState.kills.push(signal);
  };
  return child;
}

async function createChildProcessMock() {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      spawnState.calls.push({ command, args });
      return createHungDockerChild();
    },
  };
}

vi.mock("node:child_process", async () => createChildProcessMock());

let execDockerRaw: typeof import("./docker.js").execDockerRaw;

async function loadFreshDockerModuleForTest() {
  vi.resetModules();
  vi.doMock("node:child_process", async () => createChildProcessMock());
  ({ execDockerRaw } = await import("./docker.js"));
}

describe("execDockerRaw timeout handling", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    spawnState.calls.length = 0;
    spawnState.kills.length = 0;
    await loadFreshDockerModuleForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects and kills a docker process that never exits", async () => {
    const result = execDockerRaw(["version"], { timeoutMs: 25 });
    const rejection = expect(result).rejects.toMatchObject({
      name: "TimeoutError",
      code: "ETIMEDOUT",
      message:
        "docker version timed out after 25ms. Docker may be hung; restart Docker, or set `agents.defaults.sandbox.mode=off` to disable sandboxing.",
    });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(spawnState.calls).toEqual([{ command: "docker", args: ["version"] }]);
    expect(spawnState.kills).toEqual(["SIGTERM"]);
  });

  it("preserves caller abort handling while the default deadline is pending", async () => {
    const controller = new AbortController();
    const result = execDockerRaw(["version"], { signal: controller.signal });
    const rejection = expect(result).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });

    controller.abort();

    await rejection;
    expect(spawnState.kills).toEqual(["SIGTERM"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
