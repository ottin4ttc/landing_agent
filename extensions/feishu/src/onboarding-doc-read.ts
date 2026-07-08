// landingAgent-specific (not upstream openclaw): read a wiki doc's raw text
// with a user_access_token, dispatching by obj_type. Legacy "doc" (doccn...)
// uses doc/v2; new "docx" uses docx/v1.
import { FeishuUserTokenError } from "./user-token.js";

const FEISHU_BASE = "https://open.feishu.cn";

type RawContentResponse = { code?: number; msg?: string; data?: { content?: string } };

type WikiNodeResponse = {
  code?: number;
  msg?: string;
  data?: { node?: { obj_token?: string; obj_type?: string } };
};

/**
 * landingAgent-specific: resolve a wiki node_token to its underlying
 * obj_token/obj_type (a wiki node is not the same identity as the docx
 * document_id or legacy doc token it wraps).
 */
export async function resolveWikiNodeObject(
  deps: { getUserAccessToken: () => Promise<string>; fetchImpl?: typeof fetch },
  wikiToken: string,
): Promise<{ objToken: string; objType: string }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const token = await deps.getUserAccessToken();
  const res = await doFetch(
    `${FEISHU_BASE}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(wikiToken)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = (await res.json()) as WikiNodeResponse;
  if (json.code !== 0) {
    throw new FeishuUserTokenError(
      `feishu wiki get_node failed (${json.code}): ${json.msg ?? ""}`,
      json.code,
    );
  }
  const objToken = json.data?.node?.obj_token;
  const objType = json.data?.node?.obj_type;
  if (!objToken || !objType) {
    throw new FeishuUserTokenError("feishu wiki get_node returned no obj_token/obj_type");
  }
  return { objToken, objType };
}

export async function readWikiDocContent(
  deps: { getUserAccessToken: () => Promise<string>; fetchImpl?: typeof fetch },
  objToken: string,
  objType: string,
): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch;
  let url: string;
  if (objType === "docx") {
    url = `${FEISHU_BASE}/open-apis/docx/v1/documents/${objToken}/raw_content`;
  } else if (objType === "doc") {
    url = `${FEISHU_BASE}/open-apis/doc/v2/${objToken}/raw_content`;
  } else {
    throw new Error(`暂不支持读取该类型文档（unsupported obj_type）: ${objType}`);
  }
  const token = await deps.getUserAccessToken();
  const res = await doFetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json()) as RawContentResponse;
  if (json.code !== 0) {
    throw new Error(`feishu read doc failed (${json.code}): ${json.msg ?? ""}`);
  }
  return json.data?.content ?? "";
}
