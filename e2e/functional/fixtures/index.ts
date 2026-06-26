/**
 * Custom Playwright test fixture for functional tests.
 *
 * Provides typed access to the e2e org/workspace slugs and a `base` URL
 * shorthand so specs don't have to hardcode paths.
 *
 * Usage:
 *   import { test, expect } from "../fixtures/index.js";
 *   test("my test", async ({ page, base }) => {
 *     await page.goto(`${base}/okrs`);
 *   });
 */
import { test as base, expect } from "@playwright/test";

export interface WorkspaceFixture {
  /** "e2e-test-org" */
  orgSlug: string;
  /** "e2e-workspace" */
  workspaceSlug: string;
  /** "/e2e-test-org/e2e-workspace" — prepend to workspace-relative paths */
  base: string;
}

export const test = base.extend<WorkspaceFixture>({
  orgSlug: async ({}, use) => {
    await use("e2e-test-org");
  },
  workspaceSlug: async ({}, use) => {
    await use("e2e-workspace");
  },
  base: async ({}, use) => {
    await use("/e2e-test-org/e2e-workspace");
  },
});

export { expect };
