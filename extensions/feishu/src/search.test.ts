import { describe, it, expect, vi } from "vitest";
import { searchDocs, stripHighlight } from "./search.ts";

function fakeClient(searchImpl: (payload: unknown) => Promise<unknown>) {
  return {
    search: { docWiki: { search: vi.fn(searchImpl) } },
  } as unknown as import("@larksuiteoapi/node-sdk").Client;
}

describe("stripHighlight", () => {
  it("removes em tags and trims", () => {
    expect(stripHighlight("<em>季度</em>报告")).toBe("季度报告");
    expect(stripHighlight(undefined)).toBe("");
  });
});

describe("searchDocs", () => {
  it("maps res_units to unified results and passes page_size in data", async () => {
    const search = vi.fn(async () => ({
      code: 0,
      msg: "success",
      data: {
        total: 2,
        res_units: [
          {
            title_highlighted: "<em>季度</em>报告",
            summary_highlighted: "Q3 摘要",
            entity_type: "DOC",
            result_meta: {
              doc_types: "DOCX",
              url: "https://feishu.cn/docx/aaa",
              token: "aaa",
              owner_name: "张三",
              update_time: 111,
            },
          },
          {
            title_highlighted: "Wiki 首页",
            entity_type: "WIKI",
            result_meta: { doc_types: "WIKI", url: "https://feishu.cn/wiki/bbb", token: "bbb" },
          },
        ],
      },
    }));
    const client = { search: { docWiki: { search } } } as any;
    const res = await searchDocs(client, "报告", 10);
    expect(search).toHaveBeenCalledWith({ data: { query: "报告", page_size: 10 } });
    expect(res).toEqual({
      query: "报告",
      total: 2,
      results: [
        {
          type: "DOCX",
          title: "季度报告",
          url: "https://feishu.cn/docx/aaa",
          token: "aaa",
          summary: "Q3 摘要",
          ownerName: "张三",
          updateTime: 111,
        },
        { type: "WIKI", title: "Wiki 首页", url: "https://feishu.cn/wiki/bbb", token: "bbb" },
      ],
    });
  });

  it("returns empty result set (total 0) without error", async () => {
    const client = fakeClient(async () => ({ code: 0, data: { total: 0, has_more: false } }));
    const res = await searchDocs(client, "无", 10);
    expect(res).toEqual({ query: "无", total: 0, results: [] });
  });

  it("throws with feishu msg on non-zero code (no swallow)", async () => {
    const client = fakeClient(async () => ({
      code: 99991672,
      msg: "Access denied. scope required: search:docs:read",
    }));
    await expect(searchDocs(client, "x", 10)).rejects.toThrow(/search:docs:read/);
  });

  it("clamps limit to [1,50]", async () => {
    const search = vi.fn(async () => ({ code: 0, data: { total: 0 } }));
    const client = { search: { docWiki: { search } } } as any;
    await searchDocs(client, "x", 999);
    expect(search).toHaveBeenCalledWith({ data: { query: "x", page_size: 50 } });
    await searchDocs(client, "x", 0);
    expect(search).toHaveBeenCalledWith({ data: { query: "x", page_size: 1 } });
  });
});
