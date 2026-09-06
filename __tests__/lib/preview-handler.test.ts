import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePreviewAutomation } from "@/lib/preview-automation/handler";
vi.mock("@/lib/db", () => ({ default: vi.fn(() => { throw new Error("DB must not be reached"); }) }));
describe("preview endpoint boundary", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(["production", "development", ""])("returns404 outside preview before any database access (%s)", async (env) => {
    vi.stubEnv("VERCEL_ENV", env);
    vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "1");
    const response = await handlePreviewAutomation(new Request("https://test.vercel.app/api/preview-automation/bootstrap", { method: "POST" }), "bootstrap");
    expect(response.status).toBe(404);
  });
  it("returns404 for disabled previews", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "");
    expect((await handlePreviewAutomation(new Request("https://test.vercel.app"), "bootstrap")).status).toBe(404);
  });
});
