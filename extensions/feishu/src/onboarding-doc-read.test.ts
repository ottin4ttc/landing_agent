import { describe, it, expect } from "vitest";
import { readWikiDocContent } from "./onboarding-doc-read.js";

function fetchFor(map: Record<string, unknown>) {
  return (async (url: string) => {
    const key = Object.keys(map).find((k) => url.includes(k));
    return {
      ok: true,
      json: async () => (key ? map[key] : { code: 1, msg: "no route" }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("readWikiDocContent", () => {
  it("docx 走 docx/v1/documents/{token}/raw_content", async () => {
    const fetchImpl = fetchFor({
      "/docx/v1/documents/docxYYY/raw_content": { code: 0, data: { content: "docx 正文" } },
    });
    const out = await readWikiDocContent(
      { getUserAccessToken: async () => "t", fetchImpl },
      "docxYYY",
      "docx",
    );
    expect(out).toBe("docx 正文");
  });

  it("老版 doc 走 doc/v2/{token}/raw_content", async () => {
    const fetchImpl = fetchFor({
      "/doc/v2/doccnXXX/raw_content": { code: 0, data: { content: "老版 doc 正文" } },
    });
    const out = await readWikiDocContent(
      { getUserAccessToken: async () => "t", fetchImpl },
      "doccnXXX",
      "doc",
    );
    expect(out).toBe("老版 doc 正文");
  });

  it("未知类型抛错", async () => {
    await expect(
      readWikiDocContent(
        { getUserAccessToken: async () => "t", fetchImpl: fetchFor({}) },
        "x",
        "sheet",
      ),
    ).rejects.toThrow(/不支持|unsupported/i);
  });

  it("飞书非 0 抛错", async () => {
    const fetchImpl = fetchFor({
      "/docx/v1/documents/x/raw_content": { code: 131006, msg: "permission denied" },
    });
    await expect(
      readWikiDocContent({ getUserAccessToken: async () => "t", fetchImpl }, "x", "docx"),
    ).rejects.toThrow(/permission denied|131006/);
  });
});
