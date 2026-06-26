import { test as setup, expect } from "@playwright/test";
import path from "path";
import fs from "fs";

const AUTH_FILE = path.join(__dirname, ".auth/user.json");

setup("authenticate as dev user", async ({ page }) => {
  await page.goto("/login");

  // The Dev Login button (⚡ Dev Login) is only rendered when NODE_ENV=development.
  // In CI, ensure the dev server is started with NODE_ENV=development.
  const devLoginBtn = page.getByRole("button", { name: /dev login/i });
  await expect(devLoginBtn).toBeVisible({ timeout: 10_000 });
  await devLoginBtn.click();

  // Auth.js redirects to /dashboard after a successful dev-credentials sign-in,
  // which then redirects to the user's first workspace. Accept any of these.
  await page.waitForURL(/\/(onboarding|dashboard|[^/]+\/[^/]+\/)/, {
    timeout: 15_000,
  });

  // Persist the browser's cookies and localStorage so subsequent tests skip login.
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
