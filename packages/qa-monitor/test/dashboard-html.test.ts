// landingAgent-specific (not upstream openclaw)
import { describe, it, expect } from "vitest";
import { esc, renderDashboardHtml } from "../src/web/dashboard-html.ts";

describe("esc", () => {
  it("escapes html", () => {
    expect(esc('<b>&"x')).toBe("&lt;b&gt;&amp;&quot;x");
  });
});

describe("renderDashboardHtml", () => {
  it("includes title, logged-in name, cards container, api fetch", () => {
    const html = renderDashboardHtml({ open_id: "ou_1", name: "张三" });
    expect(html).toContain("landingAgent QA");
    expect(html).toContain("张三");
    expect(html).toContain('id="cards"');
    expect(html).toContain("/qa-admin/api/dashboard");
    expect(html).toContain("/qa-admin/logout");
  });
  it("escapes the session name", () => {
    const html = renderDashboardHtml({ open_id: "x", name: "<script>evil" });
    expect(html).not.toContain("<script>evil");
    expect(html).toContain("&lt;script&gt;evil");
  });
});
