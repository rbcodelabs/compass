/**
 * Sign Out functional spec.
 *
 * Journey: from an authenticated workspace page → open the sidebar account
 *          dropdown → confirm the signed-in email is shown → sign out →
 *          confirm redirect to /login → confirm the session was actually
 *          cleared server-side (revisiting a protected route also redirects
 *          to /login, not just a client-side navigation).
 */
import { test, expect } from "../fixtures/index";
import { E2E_USER_EMAIL } from "../fixtures/seed-e2e";

const E2E_USER_NAME = "Dev User";

test.describe("Sign Out", () => {
  test("sidebar dropdown shows signed-in email and signs out", async ({ page, base }) => {
    // ── 1. Navigate to an authenticated workspace page ──────────────────────
    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");

    // ── 2. Open the sidebar account dropdown (trigger shows the user's name) ─
    await page.getByRole("button", { name: E2E_USER_NAME }).click();
    await expect(page.getByText(E2E_USER_EMAIL)).toBeVisible();

    // ── 3. Sign out ──────────────────────────────────────────────────────────
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/login");
    await expect(page).toHaveURL(/\/login/);

    // ── 4. Confirm the session was actually cleared server-side ────────────
    // A client-only redirect would still let this reload succeed; a real
    // signed-out session gets bounced back to /login by the layout guard.
    await page.goto(`${base}/okrs`);
    await expect(page).toHaveURL(/\/login/);
  });
});
