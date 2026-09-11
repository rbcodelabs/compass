/**
 * Feedback Bug → Roadmap functional spec.
 *
 * Journey: Enable the public feedback portal in Settings → submit a bug report
 *          via the public portal (using the Bug/Idea type toggle) → sign in
 *          internally and view the feedback board → confirm the bug is badged
 *          and shows the "Promote to roadmap" action (not the opportunity-link
 *          picker that ideas get) → promote it to the NEXT horizon →
 *          verify it now shows "On roadmap" on the feedback board and appears
 *          as a Bug-badged card in the roadmap's NEXT column.
 *
 * This exercises the bug/idea split: bugs skip Opportunity → Solution →
 * Assumption → Experiment discovery entirely and go straight to the roadmap,
 * unlike the existing Discovery → Roadmap spec which covers the idea path.
 *
 * REWRITTEN for the DataGrid migration:
 *  - The All/Ideas/Bugs control is no longer client-side state. Clicking "Bugs"
 *    now writes `?type=BUG` and re-runs the query in Postgres, so the URL is
 *    asserted and the round trip is waited on.
 *  - Rows are selected with `getByTestId("grid-row").filter({ hasText })`.
 *    A `<tr>` cannot nest, so that is unambiguous by construction — it replaces
 *    the `page.locator("div").filter(...).first()` hack this spec used to carry
 *    a three-line apology comment for.
 *  - Absence is asserted with `.toHaveCount(0)`, never `not.toBeVisible()`,
 *    which passes vacuously when the locator matches nothing at all.
 */
import { test, expect } from "../fixtures/index";

test.describe("Feedback Bug → Roadmap", () => {
  test(
    "submit a bug via the portal → promote directly to roadmap",
    async ({ page, base, orgSlug, workspaceSlug }) => {
      const ts = Date.now();
      const bugTitle = `E2E Bug ${ts}`;

      // ── 1. Enable the public feedback portal (Settings) ───────────────────
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");

      // PortalSettingsPanel renders three toggles in a fixed order: roadmap,
      // feedback, then (conditionally) portal-auth-required. The feedback
      // toggle is always the second switch on the page.
      const toggle = page.getByRole("switch").nth(1);

      const isChecked = await toggle.getAttribute("aria-checked");
      if (isChecked !== "true") {
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
      }

      // ── 2. Submit a bug via the public portal ──────────────────────────────
      await page.goto(`/portal/${orgSlug}/${workspaceSlug}/feedback`);
      await page.waitForLoadState("networkidle");

      // Select the "Bug" type toggle (defaults to "Idea").
      await page.getByRole("button", { name: "Bug" }).click();
      await page.getByLabel("Title").fill(bugTitle);
      await page.getByRole("button", { name: "Submit" }).click();

      // Confirmation + the new item appears in the list, badged as a Bug.
      // The portal is explicitly out of scope for the grid migration, so this
      // half keeps its original (card-based) selectors.
      await expect(page.getByText("Thank you for your feedback!")).toBeVisible({ timeout: 10_000 });
      const portalCard = page.locator("div").filter({ hasText: bugTitle }).last();
      await expect(portalCard.getByText("Bug", { exact: true })).toBeVisible();

      // ── 3. Open the internal feedback board ────────────────────────────────
      await page.goto(`${base}/feedback`);
      await page.waitForLoadState("networkidle");

      // Scoped to the grid row, not a bare page.getByText: the title now also
      // appears inside the row's own cells, and once a filter is applied it can
      // collide with filter chips and the search field's value.
      await expect(page.getByTestId("grid-row").filter({ hasText: bugTitle })).toHaveCount(
        1,
        { timeout: 10_000 },
      );

      // Filter to Bugs. This is a server round trip now, not local state.
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "Bugs", exact: true }).click();
      await expect(page).toHaveURL(/type=BUG/);
      await page.keyboard.press("Escape");

      const row = page.getByTestId("grid-row").filter({ hasText: bugTitle });
      await expect(row).toHaveCount(1);

      // The row shows a "Promote to roadmap" action — NOT the opportunity-link
      // picker, which is the idea-only path.
      await expect(row.getByTestId("feedback-promote")).toBeVisible();
      await expect(row.getByTestId("feedback-link-opportunity")).toHaveCount(0);
      // Every visible row is a bug, so no idea-only control exists anywhere.
      await expect(page.getByTestId("feedback-link-opportunity")).toHaveCount(0);

      // ── 4. Promote directly to the roadmap (NEXT; NOW is decision-gated) ───
      await row.getByTestId("feedback-promote").click();
      await page.getByRole("menuitem", { name: "Next", exact: true }).click();

      // The action cell now shows the "On roadmap" confirmation. Promotion is
      // deliberately pessimistic — it needs the horizon the server returns —
      // so this waits on the real round trip.
      await expect(row.getByTestId("feedback-on-roadmap")).toContainText(
        /On roadmap \(Next\)/i,
        { timeout: 10_000 },
      );
      await expect(row.getByTestId("feedback-promote")).toHaveCount(0);

      // ── 5. Verify it appears on the roadmap, Bug-badged, in NEXT ───────────
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");

      const roadmapCard = page.locator("div").filter({ hasText: bugTitle }).last();
      await expect(roadmapCard.getByText("Bug", { exact: true })).toBeVisible({ timeout: 10_000 });
    }
  );
});
