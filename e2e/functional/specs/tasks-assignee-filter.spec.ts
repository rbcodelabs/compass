/**
 * Tasks assignee-filter functional spec.
 *
 * Journey: create one assigned and one unassigned task in the TODO column →
 *          confirm the unassigned one renders an explicit "Unassigned" label
 *          rather than a blank slot → apply the "Unassigned" assignee filter
 *          from the Filters menu on the DEFAULT board view → confirm the board
 *          itself actually narrows → clear the filter → confirm it widens back.
 *
 * The narrowing assertions are the point. The board holds its columns in client
 * state, so a filter change re-renders the server page with a different task
 * set while the same client instance stays mounted. Asserting only on the URL
 * would pass even when the board keeps rendering the pre-filter cards, which is
 * exactly the regression this covers.
 */
import { test, expect } from "../fixtures/index";
import type { Locator, Page } from "@playwright/test";

async function dragCardBefore(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("task reorder card has no bounding box");

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 15, sourceBox.y + sourceBox.height / 2 + 15, { steps: 5 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 15 });
  await page.mouse.up();
}

async function appearsBefore(column: Locator, first: string, second: string) {
  const cards = await column.locator('[data-slot="card"]').allTextContents();
  const firstIndex = cards.findIndex((text) => text.includes(first));
  const secondIndex = cards.findIndex((text) => text.includes(second));
  return firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex;
}

test.describe("Tasks assignee filter", () => {
  test(
    "unassigned tasks are labelled and isolable from the default board view",
    async ({ page, base }, testInfo) => {
      const ts = Date.now();
      const assignedTitle = `E2E Assigned ${ts}`;
      const unassignedTitle = `E2E Unassigned ${ts}`;
      const secondUnassignedTitle = `E2E Unassigned second ${ts}`;

      await page.goto(`${base}/tasks`);
      await page.waitForLoadState("networkidle");

      const todoColumn = page.locator('[data-task-column="TODO"]');
      const cardIn = (title: string) =>
        page.locator('[data-task-column] [data-slot="card"]').filter({ hasText: title });

      // ── 1. A task assigned to the signed-in dev user ────────────────────────
      await todoColumn.getByRole("button", { name: /Add task/i }).click();
      await page.getByLabel("Title").fill(assignedTitle);
      // The picker defaults to "Unassigned"; pick the first real person so this
      // task is genuinely excluded by the unassigned filter later.
      await todoColumn.getByLabel("Assignee (optional)").click();
      await page.getByRole("option").filter({ hasText: "People · " }).first().click();
      await todoColumn.getByRole("button", { name: "Add Task", exact: true }).click();
      await expect(cardIn(assignedTitle)).toBeVisible({ timeout: 10_000 });

      // ── 2. A task left with no assignee at all ──────────────────────────────
      await todoColumn.getByRole("button", { name: /Add task/i }).click();
      await page.getByLabel("Title").fill(unassignedTitle);
      await todoColumn.getByRole("button", { name: "Add Task", exact: true }).click();
      await expect(cardIn(unassignedTitle)).toBeVisible({ timeout: 10_000 });

      await todoColumn.getByRole("button", { name: /Add task/i }).click();
      await page.getByLabel("Title").fill(secondUnassignedTitle);
      await todoColumn.getByRole("button", { name: "Add Task", exact: true }).click();
      await expect(cardIn(secondUnassignedTitle)).toBeVisible({ timeout: 10_000 });

      // ── 3. The empty slot is stated, not left blank ─────────────────────────
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(cardIn(unassignedTitle).getByText("Unassigned", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(cardIn(assignedTitle).getByText("Unassigned", { exact: true })).toHaveCount(0);

      // ── 4. Filter to Unassigned on the default board view ───────────────────
      await page.getByRole("button", { name: "Filters" }).click();
      await page.getByRole("menuitemradio", { name: "Unassigned", exact: true }).click();
      await page.waitForURL(/assignee=__unassigned__/, { timeout: 15_000 });

      // Base UI's Menu.RadioItem keeps the menu open (`closeOnClick` defaults to
      // false, unlike a plain MenuItem), so the menu must be dismissed before the
      // trigger can reopen it in step 5 — clicking "Filters" again while it is
      // still open just toggles it shut, and the "Clear all" item then detaches
      // mid-close instead of becoming clickable. Same reason
      // native-timeline-rollout.spec.ts escapes before reopening "View options".
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("menuitemradio", { name: "Unassigned", exact: true })
      ).toHaveCount(0);

      // The board must narrow, not just the URL.
      await expect(cardIn(unassignedTitle)).toBeVisible({ timeout: 10_000 });
      await expect(cardIn(secondUnassignedTitle)).toBeVisible();
      await expect(cardIn(assignedTitle)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("board-filtered-unassigned.png"), fullPage: true });

      // Reorder only the two visible cards. The assigned task is filtered out,
      // but the server must keep its full-column position while renumbering all
      // siblings so this visible order survives a fresh read.
      const reorderResponse = page.waitForResponse((response) =>
        response.request().method() === "POST" &&
        Boolean(response.request().headers()["next-action"]) &&
        new URL(response.url()).pathname === `${base}/tasks`
      );
      await dragCardBefore(
        page,
        cardIn(secondUnassignedTitle).getByLabel("Drag to reorder"),
        cardIn(unassignedTitle)
      );
      const response = await reorderResponse;
      expect(await response.finished()).toBeNull();
      expect(response.ok()).toBe(true);
      await expect.poll(() => appearsBefore(todoColumn, secondUnassignedTitle, unassignedTitle)).toBe(true);

      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect.poll(() => appearsBefore(todoColumn, secondUnassignedTitle, unassignedTitle)).toBe(true);

      // ── 5. Clearing the filter widens the board again ───────────────────────
      await page.getByRole("button", { name: "Filters" }).click();
      await page.getByRole("menuitem", { name: "Clear all" }).click();
      await page.waitForURL((url) => !url.search.includes("assignee="), { timeout: 15_000 });
      await expect(cardIn(assignedTitle)).toBeVisible({ timeout: 10_000 });
      await expect(cardIn(unassignedTitle)).toBeVisible();
      await expect(cardIn(secondUnassignedTitle)).toBeVisible();
      await expect.poll(() => appearsBefore(todoColumn, assignedTitle, secondUnassignedTitle)).toBe(true);
      await expect.poll(() => appearsBefore(todoColumn, assignedTitle, unassignedTitle)).toBe(true);
      await expect.poll(() => appearsBefore(todoColumn, secondUnassignedTitle, unassignedTitle)).toBe(true);

      // ── 6. The list view states the same thing ──────────────────────────────
      await page.goto(`${base}/tasks?view=list`);
      await page.waitForLoadState("networkidle");
      const unassignedRow = page.locator("tbody tr").filter({ hasText: unassignedTitle });
      await expect(unassignedRow.getByText("Unassigned", { exact: true })).toBeVisible({ timeout: 10_000 });

      // ── 7. And so does the task detail ──────────────────────────────────────
      // The row title opens the shared detail panel instead of navigating; the
      // panel's Assignee field must still state the empty slot outright rather
      // than render a blank control.
      await page.goto(`${base}/tasks?view=list`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: unassignedTitle }).click();
      await expect(page).toHaveURL(/detail=task/, { timeout: 15_000 });
      const panel = page.locator('[data-slot="sheet-content"]');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByRole("combobox", { name: "Assignee" })).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByRole("combobox", { name: "Assignee" })).toContainText("Unassigned", {
        timeout: 15_000,
      });
    }
  );
});
