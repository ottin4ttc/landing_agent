// Feishu plugin module implements content search behavior (doc_wiki/search).
import type * as Lark from "@larksuiteoapi/node-sdk";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuSearchSchema } from "./search-schema.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import { toolExecutionErrorResult } from "./tool-result.js";

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

export function registerFeishuSearchTools(api: OpenClawPluginApi): void {
  if (!api.config) return;
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.search) return;

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_search",
        label: "Feishu Search",
        description:
          "Search Feishu cloud documents and wiki by keyword. Returns matching docs (title, type, url, token). Use when the user asks to find/search feishu docs or wiki content.",
        parameters: FeishuSearchSchema,
        async execute(_toolCallId, params) {
          const p = params as { query: string; limit?: number; accountId?: string };
          try {
            const client = createFeishuToolClient({
              api,
              executeParams: p,
              defaultAccountId,
              requiredTool: { family: "search", label: "Search" },
            });
            return jsonResult(await searchDocs(client, p.query, p.limit ?? 10));
          } catch (err) {
            return toolExecutionErrorResult(err);
          }
        },
      };
    },
    { name: "feishu_search" },
  );
}
