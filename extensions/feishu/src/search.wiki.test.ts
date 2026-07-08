import { describe, it, expect } from "vitest";
import { searchWikiNodes } from "./search.js";

function fakeFetch(payload: unknown, capture?: (url: string, body: unknown) => void) {
  return (async (url: string, init?: { body?: string }) => {
    capture?.(url, init?.body ? JSON.parse(init.body) : undefined);
    return { ok: true, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
}

const wikiResp = {
  code: 0,
  data: {
    items: [
      {
        node_id: "wikcnAAA",
        space_id: "7065",
        obj_token: "doccnXXX",
        obj_type: "doc",
        title: "TTC制度07-1 Billing",
        url: "https://x.feishu.cn/wiki/wikcnAAA",
      },
      {
        node_id: "wikcnBBB",
        space_id: "7065",
        obj_token: "docxYYY",
        obj_type: "docx",
        title: "报销制度",
        url: "https://x.feishu.cn/wiki/wikcnBBB",
      },
    ],
  },
};

describe("searchWikiNodes", () => {
  it("映射 wiki 节点为 FeishuSearchResult（含 objToken/objType）", async () => {
    const r = await searchWikiNodes(
      { getUserAccessToken: async () => "user-tok", fetchImpl: fakeFetch(wikiResp) },
      "billing",
      10,
    );
    expect(r.query).toBe("billing");
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toMatchObject({
      title: "TTC制度07-1 Billing",
      token: "wikcnAAA",
      objToken: "doccnXXX",
      objType: "doc",
      url: "https://x.feishu.cn/wiki/wikcnAAA",
    });
  });

  it("带 spaceId 时请求体含 space_id，limit 截断", async () => {
    let seenBody: any;
    const r = await searchWikiNodes(
      {
        getUserAccessToken: async () => "user-tok",
        fetchImpl: fakeFetch(wikiResp, (_u, b) => (seenBody = b)),
        spaceId: "7065",
      },
      "billing",
      1,
    );
    expect(seenBody).toMatchObject({ query: "billing", space_id: "7065" });
    expect(r.results).toHaveLength(1);
  });

  it("飞书非 0 抛错", async () => {
    await expect(
      searchWikiNodes(
        {
          getUserAccessToken: async () => "t",
          fetchImpl: fakeFetch({ code: 99991663, msg: "bad token" }),
        },
        "x",
        10,
      ),
    ).rejects.toThrow(/bad token|99991663/);
  });
});
