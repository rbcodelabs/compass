/**
 * Roadmap Timeline functional spec.
 *
 * Journey: Add a roadmap item with a start/end date via the inline add form →
 *          switch the Roadmap page to the Timeline view (?view=timeline) →
 *          confirm the dated item renders as a normal bar and a second,
 *          dateless item renders as a dashed "(unscheduled)" placeholder bar
 *          → click through every zoom level (Year/Quarter/Month/Week/Day) and
 *          confirm the header scale updates and both items stay visible →
 *          switch Group by to Squad and confirm both items nest under a
 *          "No squad" summary row, then back to None → switch back to
 *          Board → edit the dateless item via the card's
 *          Edit action to give it dates → confirm the date range chip
 *          appears on the card and the item now shows up as a normal
 *          (non-placeholder) bar on the Timeline after a reload, confirming
 *          persistence.
 *
 * This is the first user-facing journey for the Board/Timeline toggle and
 * roadmap item date fields, so it's a new spec rather than an extension of
 * an existing one.
 */
import { test, expect } from "../fixtures/index";

test.describe("Roadmap Timeline", () => {
  test(
    "add item with dates → view on Timeline → add dates to an existing item via Edit → persists",
    async ({ page, base }) => {
      const ts = Date.now();
      const datedTitle = `E2E Timeline Item ${ts}`;
      const editedTitle = `E2E Dateless Item ${ts}`;

      // ── 1. Add a roadmap item with dates in NEXT (NOW is decision-gated) ───
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: "Add item" }).nth(1).click();
      await page.getByLabel("Title").fill(datedTitle);
      await page.getByLabel("Start date (optional)").fill("2026-07-01");
      await page.getByLabel("End date (optional)").fill("2026-09-30");
      // exact: true — otherwise this also matches the "Add item" trigger
      // buttons still collapsed in the other (NEXT/LATER/SHIPPED) columns,
      // since Playwright's accessible-name matching is substring + case-
      // insensitive by default.
      await page.getByRole("button", { name: "Add Item", exact: true }).click();

      // Scope to [data-slot="card"] rather than a bare div — a hasText filter
      // on plain "div" matches every ancestor whose concatenated text
      // includes the title, up to and including the whole column's card
      // list, so .first()/.last() land on the wrong (much larger) element.
      const datedCard = page.locator('[data-slot="card"]').filter({ hasText: datedTitle });
      await expect(datedCard).toBeVisible({ timeout: 10_000 });

      // Also add a second, dateless item we'll edit later.
      await page.getByRole("button", { name: "Add item" }).nth(1).click();
      await page.getByLabel("Title").fill(editedTitle);
      await page.getByRole("button", { name: "Add Item", exact: true }).click();
      await expect(
        page.locator('[data-slot="card"]').filter({ hasText: editedTitle })
      ).toBeVisible({ timeout: 10_000 });

      // ── 2. Switch to Timeline view and confirm the dated item is a bar ─────
      await page.getByRole("tab", { name: "Timeline" }).click();
      await expect(page).toHaveURL(/view=timeline/);
      await page.waitForLoadState("networkidle");

      // The Gantt library renders the task name in both its own grid table
      // and our custom bar template, so scope to .first() to avoid a
      // strict-mode violation — either occurrence confirms the item rendered.
      await expect(page.getByText(datedTitle).first()).toBeVisible({ timeout: 10_000 });
      // The dateless item still appears, as a dashed placeholder bar — scope
      // to the bar's own tooltip `title` attribute (set only on placeholder
      // bars in TaskBar) rather than a text/hasText match, since the Gantt
      // library renders the task name in several of its own internal DOM
      // nodes (grid column, virtualization buffers) that would also match
      // and don't carry our "(unscheduled)" label.
      const placeholderBarSelector = '[title="No dates set yet — drag or resize this bar to schedule it"]';
      const placeholderBar = page.locator(placeholderBarSelector, { hasText: editedTitle });
      await expect(placeholderBar).toBeVisible({ timeout: 10_000 });

      // ── 2b. Zoom level switcher: each level re-renders both items without
      //        losing them, and the header scale reflects the chosen unit ────
      await page.getByRole("tab", { name: "Year", exact: true }).click();
      await expect(page.getByText("2026", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(datedTitle).first()).toBeVisible();
      await expect(placeholderBar).toBeVisible();

      await page.getByRole("tab", { name: "Quarter", exact: true }).click();
      await expect(page.getByText(/^Q[1-4]$/).first()).toBeVisible({ timeout: 10_000 });

      await page.getByRole("tab", { name: "Month", exact: true }).click();
      // datedTitle spans Jul–Sep 2026, so all three month labels are present.
      await expect(page.getByText("Jul", { exact: true })).toBeVisible({ timeout: 10_000 });

      await page.getByRole("tab", { name: "Week", exact: true }).click();
      await expect(page.getByText(datedTitle).first()).toBeVisible({ timeout: 10_000 });

      // Back to Day (the default) so the rest of the journey proceeds against
      // the same view the test started from.
      await page.getByRole("tab", { name: "Day", exact: true }).click();
      await expect(page.getByText(datedTitle).first()).toBeVisible({ timeout: 10_000 });
      await expect(placeholderBar).toBeVisible();

      // ── 2c. Group by squad: neither test item (nor anything else in this
      //        seeded workspace) has a squad, so everything nests under one
      //        "No squad" summary row — count isn't asserted exactly since
      //        other seeded/pre-existing items may also land in it, just
      //        that grouping activates and both test items are still there.
      await page.getByRole("tab", { name: "Squad", exact: true }).click();
      await expect(page.getByText(/^No squad \(\d+\)$/).first()).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(datedTitle).first()).toBeVisible();
      await expect(placeholderBar).toBeVisible();

      // Back to ungrouped (the default) so the rest of the journey proceeds
      // against the same view the test started from.
      await page.getByRole("tab", { name: "None", exact: true }).click();
      await expect(page.getByText(/^No squad \(\d+\)$/)).toHaveCount(0);
      await expect(page.getByText(datedTitle).first()).toBeVisible({ timeout: 10_000 });

      // ── 3. Back to Board, edit the dateless item to add dates ──────────────
      await page.getByRole("tab", { name: "Board" }).click();
      await expect(page).not.toHaveURL(/view=timeline/);
      await page.waitForLoadState("networkidle");

      const editedRow = page.locator('[data-slot="card"]').filter({ hasText: editedTitle });
      await editedRow.hover();
      await editedRow.getByLabel("Card actions").click();
      await page.getByRole("menuitem", { name: "Edit" }).click();

      await page.getByLabel("Start date").fill("2026-08-01");
      await page.getByLabel("End date").fill("2026-08-15");
      await page.getByRole("button", { name: "Save changes" }).click();

      // The dialog closes and the date chip now shows on the card.
      await expect(page.getByRole("button", { name: "Save changes" })).not.toBeVisible({
        timeout: 10_000,
      });
      const updatedCard = page.locator('[data-slot="card"]').filter({ hasText: editedTitle });
      await expect(updatedCard.getByText(/Aug/)).toBeVisible({ timeout: 10_000 });

      // ── 4. Reload and confirm the newly-dated item now shows as a normal
      //      (non-placeholder) bar on the Timeline ─────────────────────────
      await page.goto(`${base}/roadmap?view=timeline`);
      await page.waitForLoadState("networkidle");

      await expect(page.getByText(datedTitle).first()).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(editedTitle).first()).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(placeholderBarSelector, { hasText: editedTitle })).toHaveCount(0);
    }
  );
});
