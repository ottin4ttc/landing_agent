// LongCat live tests cover the hosted LongCat-2.0 API.
import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { buildLongCatProvider } from "./provider-catalog.js";

const LONGCAT_KEY = process.env.LONGCAT_API_KEY ?? "";
const LIVE = ["LIVE", "OPENCLAW_LIVE_TEST", "LONGCAT_LIVE_TEST"].some((name) => {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
});
const LONGCAT_LIVE_TIMEOUT_MS = 60_000;

const describeLive = LIVE && LONGCAT_KEY ? describe : describe.skip;

function requireLiveModel(): Model<"openai-completions"> {
  const model = buildLongCatProvider().models?.[0];
  if (!model) {
    throw new Error("LongCat catalog did not provide a model");
  }
  return {
    ...model,
    api: "openai-completions",
    baseUrl: "https://api.longcat.chat/openai",
    provider: "longcat",
    input: ["text"],
    cost: { ...model.cost },
  } as Model<"openai-completions">;
}

describeLive("LongCat hosted API", () => {
  it(
    "LongCat-2.0 returns assistant text",
    async () => {
      const response = await completeSimple(
        requireLiveModel(),
        {
          messages: [
            {
              role: "user",
              content: "Reply with the word ok.",
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: LONGCAT_KEY,
          maxTokens: 128,
        },
      );
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join(" ");

      expect(text.length).toBeGreaterThan(0);
    },
    LONGCAT_LIVE_TIMEOUT_MS,
  );
});
