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

  it("total 取 API 返回的 data.total，而不是本页 results.length", async () => {
    const respWithTotal = {
      code: 0,
      data: {
        total: 42,
        items: wikiResp.data.items.slice(0, 1),
      },
    };
    const r = await searchWikiNodes(
      { getUserAccessToken: async () => "user-tok", fetchImpl: fakeFetch(respWithTotal) },
      "billing",
      10,
    );
    expect(r.results).toHaveLength(1);
    expect(r.total).toBe(42);
  });

  it("spaceIds 多空间：逐个搜索、合并去重、limit 截断", async () => {
    const bodies: any[] = [];
    const bySpace: Record<string, unknown> = {
      A: {
        code: 0,
        data: {
          total: 2,
          items: [
            { node_id: "n1", obj_token: "o1", obj_type: "doc", title: "t1", url: "u1" },
            { node_id: "dup", obj_token: "od", obj_type: "docx", title: "td", url: "ud" },
          ],
        },
      },
      B: {
        code: 0,
        data: {
          total: 2,
          items: [
            { node_id: "dup", obj_token: "od", obj_type: "docx", title: "td", url: "ud" },
            { node_id: "n3", obj_token: "o3", obj_type: "doc", title: "t3", url: "u3" },
          ],
        },
      },
    };
    const fetchImpl = (async (_url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      bodies.push(body);
      return { ok: true, json: async () => bySpace[body.space_id] } as unknown as Response;
    }) as unknown as typeof fetch;

    const r = await searchWikiNodes(
      { getUserAccessToken: async () => "user-tok", fetchImpl, spaceIds: ["A", "B"] },
      "q",
      10,
    );
    // 一个 space 一个请求，各带自己的 space_id
    expect(bodies.map((b) => b.space_id)).toEqual(["A", "B"]);
    // 合并去重：n1, dup, n3（dup 只一次）
    expect(r.results.map((x) => x.token)).toEqual(["n1", "dup", "n3"]);
  });

  it("spaceIds 达到 limit 后停止跨空间搜索", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      bodies.push(body);
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            items: [{ node_id: `${body.space_id}-n`, obj_type: "doc", title: "t", url: "u" }],
          },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const r = await searchWikiNodes(
      { getUserAccessToken: async () => "t", fetchImpl, spaceIds: ["A", "B", "C"] },
      "q",
      1,
    );
    expect(r.results).toHaveLength(1);
    // 第一个 space 就满足 limit=1，不再请求后续 space
    expect(bodies).toHaveLength(1);
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
