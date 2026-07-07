// Feishu plugin module implements content search behavior (doc_wiki/search).
import type * as Lark from "@larksuiteoapi/node-sdk";

export type FeishuSearchResultItem = {
  type: string;
  title: string;
  url: string;
  token: string;
  summary?: string;
  ownerName?: string;
  updateTime?: number;
};

export type FeishuSearchResult = {
  query: string;
  total: number;
  results: FeishuSearchResultItem[];
};

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

export function stripHighlight(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/<[^>]+>/g, "").trim();
}

function clampLimit(limit: number | undefined): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, n));
}

type FeishuSearchResUnit = {
  title_highlighted?: string;
  summary_highlighted?: string;
  entity_type?: string;
  result_meta?: {
    doc_types?: string;
    url?: string;
    token?: string;
    owner_name?: string;
    update_time?: number;
  };
};

type FeishuDocWikiSearchResponse = {
  code?: number;
  msg?: string;
  data?: {
    total?: number;
    res_units?: FeishuSearchResUnit[];
  };
};

export async function searchDocs(
  client: Lark.Client,
  query: string,
  limit: number,
): Promise<FeishuSearchResult> {
  const pageSize = clampLimit(limit);
  const res = (await client.search.docWiki.search({
    data: { query, page_size: pageSize },
  })) as FeishuDocWikiSearchResponse;
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const units = res.data?.res_units ?? [];
  const results: FeishuSearchResultItem[] = units.map((u) => {
    const m = u.result_meta ?? {};
    const item: FeishuSearchResultItem = {
      type: m.doc_types ?? u.entity_type ?? "",
      title: stripHighlight(u.title_highlighted),
      url: m.url ?? "",
      token: m.token ?? "",
    };
    const summary = stripHighlight(u.summary_highlighted);
    if (summary) item.summary = summary;
    if (m.owner_name) item.ownerName = m.owner_name;
    if (typeof m.update_time === "number") item.updateTime = m.update_time;
    return item;
  });

  return { query, total: res.data?.total ?? results.length, results };
}
