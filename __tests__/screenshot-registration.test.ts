import { afterEach, describe, expect, it, vi } from "vitest";

const register = vi.hoisted(() => Object.assign(vi.fn(), {
  describe: (_title: string, define: () => void) => define(),
  beforeAll: vi.fn(),
  afterAll: vi.fn(),
  use: vi.fn(),
}));
vi.mock("@playwright/test", () => ({ test: register }));

describe("settings screenshot registration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    register.mockClear();
  });

  it.each([
    { functional: undefined, optIn: undefined, settings: false },
    { functional: "1", optIn: undefined, settings: true },
    { functional: undefined, optIn: "1", settings: true },
  ])("registers shell captures for functional=$functional, optIn=$optIn: $settings", async ({ functional, optIn, settings }) => {
    vi.stubEnv("E2E_FUNCTIONAL", functional);
    vi.stubEnv("DOCS_SETTINGS_SHELL_SCREENSHOTS", optIn);
    await import("@/e2e/screenshots.spec");

    const captures = register.mock.calls.map(([title]) => title)
      .filter((title) => /^capture settings-(account|organization|nav)-/.test(title));
    expect(captures).toEqual(settings ? [
      "capture settings-account-desktop.png",
      "capture settings-organization-desktop.png",
      "capture settings-nav-mobile.png",
      "capture settings-nav-mobile-open.png",
    ] : []);
  });
});
