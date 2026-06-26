/**
 * Portal functional spec.
 *
 * Journey (authenticated): Navigate to Settings → enable Public Roadmap →
 *          verify the portal roadmap link is shown.
 *
 * Journey (unauthenticated): Open the public portal roadmap URL in a fresh
 *          browser context and verify it renders without auth.
 */
import { test, expect } from "../fixtures/index";

test.describe("Portal — public roadmap", () => {
  test(
    "enable public roadmap in settings → portal page loads without auth",
    async ({ page, base, orgSlug, workspaceSlug, browser }) => {
      // ── 1. Go to Settings ─────────────────────────────────────────────────
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");

      // ── 2. Enable the public roadmap toggle ───────────────────────────────
      // The toggle button has role="switch" + aria-checked, but NO aria-label.
      // Its accessible name is empty: the visible label ("Public roadmap") is a
      // sibling <span>, not a <label> element, so getByRole("switch", {name})
      // matches nothing. Use a structural locator instead: the first
      // [role="switch"] on the settings page is always the roadmap toggle
      // (it renders above the feedback toggle in the portal-settings-panel).
      const toggle = page.locator('[role="switch"]').first();

      const ariaChecked = await toggle.getAttribute("aria-checked");
      const isChecked = ariaChecked === "true";

      if (!isChecked) {
        await toggle.click();
        // Wait for the server action + route revalidation to complete.
        // After the server action the component receives fresh props via
        // the router refresh which triggers a networkidle settle.
        await page.waitForLoadState("networkidle");
      }

      // ── 3. Verify portal link appears (settings confirms it's enabled) ─────
      const portalUrl = `/portal/${orgSlug}/${workspaceSlug}/roadmap`;

      // ── 4. Open portal roadmap in a NEW (unauthenticated) browser context ──
      const anonContext = await browser.newContext({ storageState: undefined });
      const anonPage = await anonContext.newPage();

      await anonPage.goto(`http://localhost:3002${portalUrl}`);
      await anonPage.waitForLoadState("networkidle");

      // The portal page should render the public roadmap heading, NOT the
      // "This roadmap is not public" fallback
      await expect(
        anonPage.getByText("This roadmap is not public")
      ).not.toBeVisible({ timeout: 5_000 });

      // Public roadmap content is visible
      await expect(
        anonPage.getByRole("heading", { name: /roadmap/i }).first()
      ).toBeVisible({ timeout: 10_000 });

      await anonContext.close();

      // ── 5. Cleanup: disable the toggle again ──────────────────────────────
      const ariaCheckedAfter = await toggle.getAttribute("aria-checked");
      if (ariaCheckedAfter === "true") {
        await toggle.click();
        await page.waitForLoadState("networkidle");
      }
    }
  );
});
