import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { installFromClawHub } from "../../ui/controllers/skills.ts";
import { renderSkills } from "../../ui/views/skills.ts";
import { page } from "./route.ts";

vi.mock("../../ui/controllers/skills.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ui/controllers/skills.ts")>()),
  installFromClawHub: vi.fn(),
}));

vi.mock("../../ui/views/skills.ts", () => ({
  renderSkills: vi.fn(() => undefined),
}));

describe("skills route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards ClawHub risk acknowledgement arguments", async () => {
    const state = { connected: true } as unknown as AppViewState;
    const module = await page.component();

    module.render({ state });
    vi.mocked(renderSkills).mock.calls[0]?.[0].onClawHubInstall("guarded-skill", true, "1.2.3");

    expect(installFromClawHub).toHaveBeenCalledWith(state, "guarded-skill", true, "1.2.3");
  });
});
