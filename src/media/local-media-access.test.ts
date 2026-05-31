import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertLocalMediaAllowed, LocalMediaAccessError } from "./local-media-access.js";
import { saveMediaBuffer } from "./store.js";

const { hoistedRoots } = vi.hoisted(() => ({ hoistedRoots: [] as string[] }));

vi.mock("./local-roots.js", () => ({
  getDefaultMediaLocalRoots: () => hoistedRoots,
}));

describe("assertLocalMediaAllowed", () => {
  it("allows managed inbound media paths before explicit root checks", async () => {
    const saved = await saveMediaBuffer(Buffer.from("png"), "image/png", "inbound");

    try {
      await expect(assertLocalMediaAllowed(saved.path, [])).resolves.toBeUndefined();
    } finally {
      await fs.rm(saved.path, { force: true });
    }
  });

  it("does not allow nested inbound paths as managed media", async () => {
    const filePath = path.join(
      path.dirname((await saveMediaBuffer(Buffer.from("png"))).path),
      "nested",
      "hidden.png",
    );
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));

    try {
      await expect(assertLocalMediaAllowed(filePath, [])).rejects.toMatchObject({
        code: "path-not-allowed",
      });
    } finally {
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it("rejects workspace-* sibling paths when localRoots is undefined (unscoped)", async () => {
    const tmpDir = path.join(
      os.tmpdir(),
      `ocl-local-media-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const workspaceDir = path.join(tmpDir, "workspace");
    const workspaceXiaoqianDir = path.join(tmpDir, "workspace-xiaoqian");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(workspaceXiaoqianDir, { recursive: true });

    const mediaPath = path.join(workspaceXiaoqianDir, "report.html");
    await fs.writeFile(mediaPath, "<html>test</html>");

    hoistedRoots.length = 0;
    hoistedRoots.push(workspaceDir);

    try {
      let accessError: unknown;
      try {
        await assertLocalMediaAllowed(mediaPath, undefined);
      } catch (error) {
        accessError = error;
      }
      expect(accessError).toBeInstanceOf(LocalMediaAccessError);
      if (!(accessError instanceof LocalMediaAccessError)) {
        throw new Error("expected LocalMediaAccessError");
      }
      expect(accessError.code).toBe("path-not-allowed");
    } finally {
      hoistedRoots.length = 0;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("allows workspace-* paths when scoped localRoots include the agent workspace", async () => {
    const tmpDir = path.join(
      os.tmpdir(),
      `ocl-local-media-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const workspaceDir = path.join(tmpDir, "workspace");
    const workspaceXiaoqianDir = path.join(tmpDir, "workspace-xiaoqian");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(workspaceXiaoqianDir, { recursive: true });

    const mediaPath = path.join(workspaceXiaoqianDir, "report.html");
    await fs.writeFile(mediaPath, "<html>test</html>");

    try {
      // Simulate scoped roots that include the agent's workspace-* directory
      await expect(
        assertLocalMediaAllowed(mediaPath, [workspaceDir, workspaceXiaoqianDir]),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
