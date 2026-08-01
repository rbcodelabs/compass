/**
 * Functional suite auth setup.
 *
 * Logs in using the dev-credentials provider (⚡ Dev Login button),
 * then saves the authenticated browser storage state to
 * e2e/functional/.auth/user.json for the functional project to reuse.
 *
 * Runs once before all functional tests (depends: functional-setup project).
 */
import { test as setup } from "@playwright/test";
import path from "path";
import fs from "fs";

const AUTH_FILE = "e2e/functional/.auth/user.json";

setup("authenticate as dev user", async ({ page }) => {
  // Ensure auth directory exists
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

  // Navigate to login
  await page.goto("/login");
  await page.waitForLoadState("networkidle");

  // Click the dev-only instant login button
  await page.getByRole("button", { name: /Dev Login/i }).click();

  // Wait for the browser to navigate away from /login
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 30_000,
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
        "Ensure NODE_ENV=development and the functional webServer is running " +
        "(see playwright.config.ts for its per-worktree port)."
    );
  }

  // Persist authenticated session
  await page.context().storageState({ path: AUTH_FILE });
  console.log("[auth setup] storageState saved →", AUTH_FILE);
});
