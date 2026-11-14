/**
 * Functional suite auth setup.
 *
 * Logs in using the dev-credentials provider (⚡ Dev Login button). It exists in `pnpm dev` and in the E2E_SERVER=prod build
 * (`pnpm build:e2e` plus E2E_MOCK_AUTH=1, see lib/e2e-harness.ts); no other build has it,
 * then saves the authenticated browser storage state to
 * e2e/functional/.auth/user.json for the functional project to reuse.
 *
 * Runs once before all functional tests (depends: functional-setup project).
 */
import { test as setup, expect } from "@playwright/test";
import path from "path";
import fs from "fs";

const AUTH_FILE = "e2e/functional/.auth/user.json";

setup("authenticate as dev user", async ({ page }) => {
  // Ensure auth directory exists
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

  // Navigate to login
  const loginResponse = await page.goto("/login");
  expect(loginResponse?.status(), "[auth setup] /login must return HTTP 200 before authentication").toBe(200);
  await expect(page.getByRole("heading", { name: "Sign in to Compass", exact: true })).toBeVisible();

  // Click the dev-only instant login button
  await page.getByRole("button", { name: /Dev Login/i }).click();

  // Wait for the browser to navigate away from /login
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    // The first authenticated navigation cold-compiles /dashboard in Next dev (E2E_SERVER unset); a prebuilt production server does
    // not compile. Keep this below the functional project's 90s test budget without imposing the shorter Playwright navigation
    // default on a valid local cold start.
    timeout: 60_000,
  });

  // Explicitly navigate to the e2e workspace to verify the session is valid
  // and the seed data is accessible
  await page.goto("/e2e-test-org/e2e-workspace/okrs");
  await page.waitForLoadState("networkidle");

  // Verify we landed on the OKRs page (not redirected back to login)
  const url = page.url();
  if (url.includes("/login")) {
    throw new Error(
      "[auth setup] Dev login did not succeed — still on login page. " +
        "Ensure the functional webServer is running as `pnpm dev`, or as E2E_SERVER=prod on a `pnpm build:e2e` artifact with E2E_MOCK_AUTH=1 " +
        "(see playwright.config.ts for its per-worktree port)."
    );
  }

  // Persist authenticated session
  await page.context().storageState({ path: AUTH_FILE });
  console.log("[auth setup] storageState saved →", AUTH_FILE);
});
