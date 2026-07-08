import { describe, it, expect } from "vitest";
import { readWikiDocContent, resolveWikiNodeObject } from "./onboarding-doc-read.js";
import { FeishuUserTokenError } from "./user-token.js";

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

describe("resolveWikiNodeObject", () => {
  it("get_node 成功 → 返回 obj_token/obj_type", async () => {
    const fetchImpl = fetchFor({
      "/wiki/v2/spaces/get_node": {
        code: 0,
        data: { node: { obj_token: "docxYYY", obj_type: "docx" } },
      },
    });
    const out = await resolveWikiNodeObject(
      { getUserAccessToken: async () => "t", fetchImpl },
      "wikcnAAA",
    );
    expect(out).toEqual({ objToken: "docxYYY", objType: "docx" });
  });

  it("飞书非 0 抛错，含 code/msg", async () => {
    const fetchImpl = fetchFor({
      "/wiki/v2/spaces/get_node": { code: 131006, msg: "permission denied" },
    });
    await expect(
      resolveWikiNodeObject({ getUserAccessToken: async () => "t", fetchImpl }, "wikcnAAA"),
    ).rejects.toBeInstanceOf(FeishuUserTokenError);
    await expect(
      resolveWikiNodeObject({ getUserAccessToken: async () => "t", fetchImpl }, "wikcnAAA"),
    ).rejects.toThrow(/permission denied|131006/);
  });
});
