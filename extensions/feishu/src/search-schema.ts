// Feishu helper module supports search schema behavior.
import { Type, type Static } from "typebox";

export const FeishuSearchSchema = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Keyword to search feishu cloud docs and wiki.",
  }),
  limit: Type.Optional(
    Type.Number({ minimum: 1, maximum: 50, description: "Max results (default 10)." }),
  ),
});

export type FeishuSearchParams = Static<typeof FeishuSearchSchema>;
