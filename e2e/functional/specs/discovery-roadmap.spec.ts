/**
 * Discovery → Roadmap functional spec.
 *
 * Journey: Create opportunity (in EXPLORING column) → open detail panel →
 *          add solution → open the solution's sidebar panel → change status
 *          to IN_DELIVERY → promote to roadmap (NEXT horizon).
 *
 * Note: The "SHIPPED" horizon promote option is added in the feat/roadmap-shipped-state
 * branch (PR #16). Update the horizon to "Shipped" once that branch merges.
 */
import { test, expect } from "../fixtures/index";
import { createOpportunityFromBoard } from "../fixtures/opportunity-composer";
import { openFullPage } from "../fixtures/full-page";

test.describe("Discovery → Roadmap", () => {
  test(
    "create opportunity → solution → promote to roadmap",
    async ({ page, base }) => {
      const ts = Date.now();
      const oppTitle = `E2E Opportunity ${ts}`;
      const solTitle = `E2E Solution ${ts}`;

      // ── 1. Navigate to Discovery board ────────────────────────────────────
      await page.goto(`${base}/discovery`);
      await page.waitForLoadState("networkidle");

      // ── 2. Create an opportunity in the EXPLORING column ──────────────────
      // The first column's "Add opportunity" opens the composer with EXPLORING preset.
      await createOpportunityFromBoard(page, oppTitle);

      // Opportunity card appears in the board
      await expect(page.getByText(oppTitle)).toBeVisible({ timeout: 15_000 });

      // ── 3. Open the opportunity detail panel ───────────────────────────────
      await page.getByRole("button", { name: oppTitle }).click();
      await expect(page).toHaveURL(/detail=opportunity/);

      // Continue into the full-page editor, where solutions are managed.
      // The outgoing panel already contains the same heading and controls, so
      // wait for the route to replace it before interacting.
      await openFullPage(page);
      const opportunityPage = page.locator('[data-slot="opportunity-detail"][data-variant="page"]');
      await expect(opportunityPage.getByRole("heading", { name: oppTitle })).toBeVisible();

      // ── 4. Add a solution ─────────────────────────────────────────────────
      await opportunityPage.getByRole("button", { name: "Add Solution" }).click();
      await opportunityPage.getByLabel("Title").fill(solTitle);
      await opportunityPage.getByRole("button", { name: "Add Solution" }).last().click();

      // Solution card appears
      await expect(opportunityPage.getByText(solTitle)).toBeVisible({ timeout: 10_000 });

      // ── 5. Open the solution's sidebar panel ────────────────────────────────
      // Status changes and Promote-to-Roadmap both moved off the (now
      // compact, non-expanding) solution card into the Solution panel.
      await opportunityPage.getByRole("button", { name: solTitle, exact: true }).click();
      const panel = page.locator('[data-slot="sheet-content"]');
      await expect(panel).toBeVisible();

      // ── 6. Change solution status to IN_DELIVERY ────────────────────────────
      // The panel's status label is "In delivery" (lowercase d — see the
      // STATUS map in solution-panel.tsx), unlike the old card's "In Delivery".
      await panel.locator('[role="combobox"]').filter({ hasText: "Idea" }).click();
      // A plain click here is deliberate: it regression-tests the Select
      // popup layer (select.tsx). Before that fix the panel layer's sheet
      // painted over the listbox and swallowed the click.
      await page.getByRole("option", { name: "In delivery" }).click();

      // The panel updates its own state in place from the PATCH response (no
      // reload needed) — just wait for the label to land.
      await expect(
        panel.locator('[role="combobox"]').filter({ hasText: "In delivery" })
      ).toBeVisible({ timeout: 10_000 });

      // ── 7. Promote to roadmap ─────────────────────────────────────────────
      // The "→ Promote to Roadmap" button appears when status is VALIDATED or IN_DELIVERY
      await panel.getByRole("button", { name: "Roadmap", exact: true }).click();
      await panel.getByRole("button", { name: /Promote to Roadmap/i }).click();

      // Direct creation in NOW is intentionally guarded. Create the delivery
      // candidate in NEXT, then exercise the explicit human decision flow.
      await panel.getByRole("combobox").filter({ hasText: "Now" }).click();
      await page.getByRole("option", { name: "Next" }).click();
      await panel.getByRole("button", { name: "→ Roadmap" }).click();

      // ── 8. Verify on roadmap ──────────────────────────────────────────────
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");

      // The solution should appear as a roadmap card.
      // Use .first() because the roadmap card shows the solution title in both
      // the card heading AND in a tooltip trigger span (linked-solution badge).
      await expect(page.getByText(solTitle).first()).toBeVisible({ timeout: 10_000 });

    }
  );
});
