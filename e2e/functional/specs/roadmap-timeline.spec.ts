/**
 * Roadmap Timeline functional spec.
 *
 * Journey: Add a roadmap item with a start/end date via the inline add form →
 *          switch the Roadmap page to the Timeline view (?view=timeline) →
 *          confirm the dated item renders as a bar → switch back to Board →
 *          edit a previously-dateless existing item via the card's Edit
 *          action to give it dates → confirm the date range chip appears on
 *          the card and the item now shows up on the Timeline after a
 *          reload, confirming persistence.
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

      // ── 1. Add a roadmap item with dates in the NOW column ─────────────────
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: "Add item" }).first().click();
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
      await page.getByRole("button", { name: "Add item" }).first().click();
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
      // The dateless item should not appear as a bar on the timeline.
      await expect(page.getByText(editedTitle)).not.toBeVisible();

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

      // ── 4. Reload and confirm the newly-dated item now appears on Timeline ─
      await page.goto(`${base}/roadmap?view=timeline`);
      await page.waitForLoadState("networkidle");

      await expect(page.getByText(datedTitle).first()).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(editedTitle).first()).toBeVisible({ timeout: 10_000 });
    }
  );
});
