import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetPluginBlobStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadOutboundMediaFromUrlMock = vi.fn();
const ZALO_OUTBOUND_MEDIA_DIR_NAME = "openclaw-zalo-outbound-media";

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: (...args: unknown[]) => loadOutboundMediaFromUrlMock(...args),
}));

import {
  clearHostedZaloMediaForTest,
  prepareHostedZaloMediaUrl,
  resolveHostedZaloMediaRoutePrefix,
  tryHandleHostedZaloMediaRequest,
} from "./outbound-media.js";

function resolveHostedZaloMediaDirName(): string {
  const workerId = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID;
  return workerId ? `${ZALO_OUTBOUND_MEDIA_DIR_NAME}-${workerId}` : ZALO_OUTBOUND_MEDIA_DIR_NAME;
}

function createMockResponse() {
  const headers = new Map<string, string>();
  return {
    headers,
    res: {
      statusCode: 200,
      setHeader(name: string, value: string) {
        headers.set(name, value);
      },
      end: vi.fn(),
    },
  };
}

describe("zalo outbound hosted media", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "openclaw-zalo-outbound-media-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    resetPluginBlobStoreForTests();
    await clearHostedZaloMediaForTest();
    loadOutboundMediaFromUrlMock.mockReset();
    loadOutboundMediaFromUrlMock.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      contentType: "image/png",
      fileName: "photo.png",
    });
  });

  afterEach(async () => {
    await clearHostedZaloMediaForTest();
    resetPluginBlobStoreForTests();
    vi.unstubAllEnvs();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("loads outbound media under OpenClaw control and returns a hosted URL", async () => {
    const hostedUrl = await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      maxBytes: 1024,
    });

    expect(loadOutboundMediaFromUrlMock).toHaveBeenCalledWith("https://example.com/photo.png", {
      maxBytes: 1024,
    });
    expect(hostedUrl).toMatch(
      /^https:\/\/gateway\.example\.com\/zalo-webhook\/media\/[a-f0-9]+\?token=[a-f0-9]+$/,
    );
  });

  it("passes proxy-aware fetch options into hosted media downloads", async () => {
    await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      maxBytes: 1024,
      proxyUrl: "http://proxy.example:8080",
    });

    expect(loadOutboundMediaFromUrlMock).toHaveBeenCalledWith("https://example.com/photo.png", {
      maxBytes: 1024,
      proxyUrl: "http://proxy.example:8080",
    });
  });

  it("stores hosted media in the OpenClaw SQLite database", async () => {
    const hostedUrl = await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      maxBytes: 1024,
    });

    if (process.platform === "win32") {
      expect(hostedUrl).toContain("/zalo-webhook/media/");
      return;
    }

    const { pathname } = new URL(hostedUrl);
    const id = pathname.split("/").pop();
    if (!id) {
      throw new Error("expected hosted Zalo media id");
    }
    expect(id).toHaveLength(24);
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);

    const dbStats = await stat(join(stateDir, "state", "openclaw.sqlite"));
    expect(dbStats.isFile()).toBe(true);
    await expect(
      stat(join(stateDir, "openclaw-zalo-outbound-media", `${id}.json`)),
    ).rejects.toThrow();
  });

  it("preserves the root webhook path when deriving the hosted media route", () => {
    expect(
      resolveHostedZaloMediaRoutePrefix({
        webhookUrl: "https://gateway.example.com/",
      }),
    ).toBe("/media");
  });

  it("serves hosted media once when the route token matches", async () => {
    const hostedUrl = await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      maxBytes: 1024,
    });
    const { pathname, search } = new URL(hostedUrl);
    const response = createMockResponse();

    const handled = await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: `${pathname}${search}`,
      } as never,
      response.res as never,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.res.end).toHaveBeenCalledWith(Buffer.from("image-bytes"));

    const secondResponse = createMockResponse();
    const handledAgain = await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: `${pathname}${search}`,
      } as never,
      secondResponse.res as never,
    );

    expect(handledAgain).toBe(true);
    expect(secondResponse.res.statusCode).toBe(404);
  });

  it("rejects hosted media preparation when the expiry would exceed a valid Date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    try {
      await expect(
        prepareHostedZaloMediaUrl({
          mediaUrl: "https://example.com/photo.png",
          webhookUrl: "https://gateway.example.com/zalo-webhook",
          maxBytes: 1024,
        }),
      ).rejects.toThrow(/expiry/);

      expect(loadOutboundMediaFromUrlMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not serve hosted media when the current clock is invalid", async () => {
    const hostedUrl = await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/zalo-webhook",
      maxBytes: 1024,
    });
    const { pathname, search } = new URL(hostedUrl);
    const response = createMockResponse();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      const handled = await tryHandleHostedZaloMediaRequest(
        {
          method: "GET",
          url: `${pathname}${search}`,
        } as never,
        response.res as never,
      );

      expect(handled).toBe(true);
      expect(response.res.statusCode).toBe(410);
      expect(response.res.end).toHaveBeenCalledWith("Expired");
    } finally {
      dateNow.mockRestore();
    }
  });

  it("rejects hosted media requests with the wrong token", async () => {
    const hostedUrl = await prepareHostedZaloMediaUrl({
      mediaUrl: "https://example.com/photo.png",
      webhookUrl: "https://gateway.example.com/custom/zalo",
      webhookPath: "/custom/zalo-hook",
      maxBytes: 1024,
    });
    const pathname = new URL(hostedUrl).pathname;
    const response = createMockResponse();

    const handled = await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: `${pathname}?token=wrong`,
      } as never,
      response.res as never,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(401);
    expect(response.res.end).toHaveBeenCalledWith("Unauthorized");
  });

  it("rejects malformed hosted media ids before touching disk", async () => {
    const response = createMockResponse();

    const handled = await tryHandleHostedZaloMediaRequest(
      {
        method: "GET",
        url: "/zalo-webhook/media/not-a-valid-hex-id?token=wrong",
      } as never,
      response.res as never,
    );

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(404);
    expect(response.res.end).toHaveBeenCalledWith("Not Found");
  });
});
