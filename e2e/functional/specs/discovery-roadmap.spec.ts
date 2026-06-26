/**
 * Discovery → Roadmap functional spec.
 *
 * Journey: Create opportunity (in EXPLORING column) → navigate to detail →
 *          add solution → change solution status to IN_DELIVERY →
 *          expand solution card → promote to roadmap (NOW horizon) →
 *          verify card appears in roadmap NOW column.
 *
 * Note: The "SHIPPED" horizon promote option is added in the feat/roadmap-shipped-state
 * branch (PR #16). Update the horizon to "Shipped" once that branch merges.
 */
import { test, expect } from "../fixtures/index";

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
      // The "Add opportunity" inline button is inside the EXPLORING column.
      // Click the first "Add opportunity" button (column-embedded mode).
      await page.getByRole("button", { name: /Add opportunity/i }).first().click();
      await page.getByLabel("Title").fill(oppTitle);
      await page.getByRole("button", { name: "Create Opportunity" }).click();

      // Opportunity card appears in the board
      await expect(page.getByText(oppTitle)).toBeVisible({ timeout: 15_000 });

      // ── 3. Navigate to the opportunity detail page ─────────────────────────
      await page.getByRole("link", { name: oppTitle }).click();
      await page.waitForLoadState("networkidle");

      // Confirm we're on the detail page (opportunity title in heading)
      await expect(page.getByRole("heading", { name: oppTitle })).toBeVisible();

      // ── 4. Add a solution ─────────────────────────────────────────────────
      await page.getByRole("button", { name: "Add Solution" }).click();
      await page.getByLabel("Title").fill(solTitle);
      await page.getByRole("button", { name: "Add Solution" }).last().click();

      // Solution card appears
      await expect(page.getByText(solTitle)).toBeVisible({ timeout: 10_000 });

      // ── 5. Change solution status to IN_DELIVERY ───────────────────────────
      // The solution card has a status Select showing "Idea" (default).
      // Click it to open and pick "In Delivery".
      await page.getByText("Idea").click();
      await page.getByRole("option", { name: "In Delivery" }).click();

      // Wait for the server action to complete; the badge should update
      await expect(page.getByText("In Delivery")).toBeVisible({ timeout: 10_000 });

      // ── 6. Expand the solution card ────────────────────────────────────────
      // The expand toggle button has aria-label="Expand"
      await page.getByRole("button", { name: "Expand" }).click();

      // ── 7. Promote to roadmap ─────────────────────────────────────────────
      // The "→ Promote to Roadmap" button appears when status is VALIDATED or IN_DELIVERY
      await page.getByRole("button", { name: /Promote to Roadmap/i }).click();

      // Promote form shows horizon Select (NOW/NEXT/LATER) and "→ Roadmap" button.
      // Default horizon is NOW — leave it and click "→ Roadmap"
      await page.getByRole("button", { name: "→ Roadmap" }).click();

      // ── 8. Verify on roadmap ──────────────────────────────────────────────
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");

      // The solution should appear as a roadmap card.
      // The NOW column is the first column (visible without scrolling at 1440px).
      await expect(page.getByText(solTitle)).toBeVisible({ timeout: 10_000 });
    }
  );
});
