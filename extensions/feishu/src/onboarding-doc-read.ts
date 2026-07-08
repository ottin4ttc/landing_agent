// landingAgent-specific (not upstream openclaw): read a wiki doc's raw text
// with a user_access_token, dispatching by obj_type. Legacy "doc" (doccn...)
// uses doc/v2; new "docx" uses docx/v1.
const FEISHU_BASE = "https://open.feishu.cn";

type RawContentResponse = { code?: number; msg?: string; data?: { content?: string } };

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
