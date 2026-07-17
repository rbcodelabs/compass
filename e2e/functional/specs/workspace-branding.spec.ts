/**
 * Workspace Branding functional spec.
 *
 * Journey (authenticated): Settings → Branding — select a preset palette,
 *          switch to a custom hex, confirm an invalid hex is rejected
 *          without crashing the page, select a preset font, switch to a
 *          custom font family, and confirm the sidebar (logo mark + active
 *          nav state) reflects the color live on a real workspace page.
 *
 * Journey (cross-surface): the same color branding set in Settings must
 *          also render on the PUBLIC portal for an unauthenticated visitor
 *          — this is the core requirement of the whole feature (branding
 *          renders in two independent layouts sharing one data source).
 *
 * Colors/fonts are deliberately distinct between the two journeys (Emerald
 * + custom blue / Poppins + Roboto Slab vs. Rose) so each test's assertions
 * are unambiguous regardless of execution order.
 *
 * Both tests mutate the SAME shared seeded workspace (there's only one
 * e2e-workspace for the whole functional suite — see fixtures/seed-e2e.ts).
 * Playwright runs separate top-level describe blocks in a file concurrently
 * across workers by default, which caused the two tests here to race on
 * that shared workspace's branding fields (observed directly: the
 * cross-surface test's color assertion intermittently read back whatever
 * the OTHER test had just written). `.serial()` forces them to run one
 * after another in a single worker instead.
 */
import { test, expect } from "../fixtures/index";

test.describe.serial("Workspace Branding", () => {
  test(
    "preset palette → custom hex → invalid hex rejected → preset font → custom font → sidebar reflects color",
    async ({ page, base }) => {
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");

      // ── 1. Force a known starting color mode, then select a preset palette ──
      await page.getByRole("button", { name: "Preset color" }).click();
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: "Select Emerald palette" }).click();
      await page.waitForLoadState("networkidle");

      // Verify a themed element (sidebar logo mark) picked up Emerald (#059669)
      // on this real, authenticated workspace page.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const el = document.querySelector("aside .bg-primary");
            return el ? getComputedStyle(el).backgroundColor : null;
          })
        )
        .toBe("rgb(5, 150, 105)");

      // ── 2. Switch to custom hex, enter a valid value, verify it applies ─────
      await page.getByRole("button", { name: "Custom color" }).click();
      await page.getByLabel("Custom hex color").fill("#3366ff");
      await page.waitForLoadState("networkidle");

      await expect
        .poll(() =>
          page.evaluate(() => {
            const el = document.querySelector("aside .bg-primary");
            return el ? getComputedStyle(el).backgroundColor : null;
          })
        )
        .toBe("rgb(51, 102, 255)");

      // ── 3. Enter an invalid hex — rejected client-side, page doesn't crash ──
      const hexInput = page.getByLabel("Custom hex color");
      await hexInput.fill("not-a-hex");
      await expect(page.getByText("Enter a 6-digit hex color, e.g. #4f3df2")).toBeVisible();
      await expect(hexInput).toHaveAttribute("aria-invalid", "true");
      // Page is still alive and the last VALID color is still applied server-side
      // (handleHexChange only calls the server action for a valid match).
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const el = document.querySelector("aside .bg-primary");
            return el ? getComputedStyle(el).backgroundColor : null;
          })
        )
        .toBe("rgb(51, 102, 255)");

      // Restore a valid value so later font interactions on this page don't
      // leave the hex field in a persistently invalid visual state.
      await hexInput.fill("#3366ff");
      await page.waitForLoadState("networkidle");

      // ── 4. Select a preset font, verify computed font-family changed ────────
      await page.getByRole("button", { name: "Preset font" }).click();
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: "Poppins" }).click();
      await page.waitForLoadState("networkidle");

      await expect
        .poll(() => page.evaluate(() => getComputedStyle(document.body).fontFamily))
        .toContain("Poppins");

      // ── 5. Enter a custom font name → Google Fonts <link> appears in <head> ─
      await page.getByRole("button", { name: "Custom font" }).click();
      await page.getByLabel("Custom font family").fill("Roboto Slab");
      await page.waitForLoadState("networkidle");

      // Scoped to rel="stylesheet" — Next.js automatically adds a companion
      // rel="preload" hint for any stylesheet link it detects in SSR'd
      // output, so a same-href, unscoped locator would (correctly) match 2.
      await expect(
        page.locator(
          'link[rel="stylesheet"][href*="fonts.googleapis.com/css2"][href*="family=Roboto+Slab"]'
        )
      ).toHaveCount(1);
      await expect
        .poll(() => page.evaluate(() => getComputedStyle(document.body).fontFamily))
        .toContain("Roboto Slab");

      // ── 6. Sidebar reflects the custom color: logo mark + active nav state ──
      await page.goto(`${base}/okrs`);
      await page.waitForLoadState("networkidle");

      await expect
        .poll(() =>
          page.evaluate(() => {
            const el = document.querySelector("aside .bg-primary");
            return el ? getComputedStyle(el).backgroundColor : null;
          })
        )
        .toBe("rgb(51, 102, 255)");

      // Active nav link uses bg-primary/20 — same custom hex at 20% alpha.
      // Chromium serializes color-mix-derived alpha colors as oklab(...),
      // not rgb(...), so compare against a fresh reference element created
      // with the identical class in the same page context instead of
      // hardcoding a browser-specific oklab string.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const active = document.querySelector('aside a[href$="/okrs"]');
            const reference = document.createElement("div");
            reference.className = "bg-primary/20";
            document.body.appendChild(reference);
            const activeColor = active ? getComputedStyle(active).backgroundColor : null;
            const referenceColor = getComputedStyle(reference).backgroundColor;
            reference.remove();
            return activeColor === referenceColor ? "MATCH" : `${activeColor} !== ${referenceColor}`;
          })
        )
        .toBe("MATCH");
    }
  );

  test(
    "cross-surface: color branding set in Settings also renders on the unauthenticated public portal",
    async ({ page, base, orgSlug, workspaceSlug, browser }) => {
      // ── 1. Set a distinct preset palette in Settings ─────────────────────────
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: "Preset color" }).click();
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "Select Rose palette" }).click();
      await page.waitForLoadState("networkidle");

      // Confirm the write actually landed and the AUTHENTICATED side sees it
      // before involving a second (anonymous) context — isolates a DB/save
      // failure from a cross-surface propagation failure if this ever fails.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const el = document.querySelector("aside .bg-primary");
            return el ? getComputedStyle(el).backgroundColor : null;
          })
        )
        .toBe("rgb(225, 29, 72)");

      // ── 2. Ensure the public roadmap is enabled so the portal page renders ──
      // PortalSettingsPanel renders roadmap as the first switch (see
      // portal.spec.ts for the same structural-locator convention — no
      // aria-label exists on these toggles).
      const roadmapToggle = page.locator('[role="switch"]').first();
      const wasPublic = (await roadmapToggle.getAttribute("aria-checked")) === "true";
      if (!wasPublic) {
        await roadmapToggle.click();
        await page.waitForLoadState("networkidle");
      }

      // ── 3. Open the portal roadmap in a FRESH, unauthenticated context ──────
      const anonContext = await browser.newContext({ storageState: undefined });
      const anonPage = await anonContext.newPage();

      await anonPage.goto(`/portal/${orgSlug}/${workspaceSlug}/roadmap`);
      await anonPage.waitForLoadState("networkidle");

      await expect(
        anonPage.getByText("This roadmap is not public")
      ).not.toBeVisible({ timeout: 5_000 });

      // Same Rose hex (#e11d48) renders on the portal header logo mark —
      // confirming the SAME branding source powers both surfaces.
      await expect
        .poll(() =>
          anonPage.evaluate(() => {
            const el = document.querySelector("header .bg-primary");
            return el ? getComputedStyle(el).backgroundColor : null;
          })
        )
        .toBe("rgb(225, 29, 72)");

      await anonContext.close();

      // ── 4. Cleanup: restore the roadmap toggle if this test turned it on ────
      if (!wasPublic) {
        const checkedAfter = await roadmapToggle.getAttribute("aria-checked");
        if (checkedAfter === "true") {
          await roadmapToggle.click();
          await page.waitForLoadState("networkidle");
        }
      }
    }
  );
});
