/**
 * Range selection, paste and fill-down on a sheet-mode grid (Tasks list view).
 *
 * Journey: create three tasks -> drag across body cells selects a range and never
 * reorders columns -> Shift+Arrow extends from the active cell -> a synthetic
 * `paste` ClipboardEvent writes a column of due dates (no clipboard permission is
 * needed, and it works in every browser) -> Ctrl+D fills the top value down ->
 * the writes persist across a reload.
 */
import { test, expect } from "../fixtures/index";
import type { Locator, Page } from "@playwright/test";

async function createTask(page: Page, base: string, title: string) {
  await page.goto(`${base}/tasks`);
  await page.waitForLoadState("networkidle");
  const todoColumn = page.locator('[data-task-column="TODO"]');
  await todoColumn.getByRole("button", { name: /Add task/i }).click();
  await page.getByLabel("Title").fill(title);
  await todoColumn.getByRole("button", { name: "Add Task", exact: true }).click();
  await expect(todoColumn.locator('[data-slot="card"]').filter({ hasText: title })).toBeVisible({
    timeout: 10_000,
  });
}

/** Dispatches a paste carrying `text` at the target, as the browser does for Ctrl+V. */
async function pasteText(target: Locator, text: string) {
  await target.evaluate((element, payload) => {
    const data = new DataTransfer();
    data.setData("text/plain", payload);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

const isTaskPatch = (response: { request(): { method(): string }; url(): string }) =>
  response.request().method() === "PATCH" && response.url().includes("/api/panels/entity/task/");

test.describe("Sheet-mode range editing (Tasks list)", () => {
  test("drag, shift-arrows, paste and fill-down", async ({ page, base }) => {
    const prefix = `E2E Range ${Date.now()}`;
    for (const suffix of ["a", "b", "c"]) await createTask(page, base, `${prefix} ${suffix}`);

    await page.goto(`${base}/tasks?view=list`);
    await page.waitForLoadState("networkidle");

    const grid = page.getByRole("grid", { name: "Tasks" });
    await expect(grid).toBeVisible();
    const rows = grid.getByRole("row").filter({ hasText: prefix });
    await expect(rows).toHaveCount(3);
    const dueCell = (index: number) => rows.nth(index).locator('[data-col="due"]');
    const pointsCell = (index: number) => rows.nth(index).locator('[data-col="points"]');

    // 1. Drag across body cells selects a rectangle and leaves the header alone.
    const headers = grid.locator("thead th");
    const headerTextBefore = await headers.allInnerTexts();
    const from = await dueCell(0).boundingBox();
    const to = await pointsCell(2).boundingBox();
    if (!from || !to) throw new Error("cells have no bounding box");
    // Past dnd-kit's 8px activation distance, entirely inside body cells.
    await page.mouse.move(from.x + 4, from.y + 4);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + 4, { steps: 5 });
    await page.mouse.move(to.x + to.width - 4, to.y + 4, { steps: 10 });
    await page.mouse.up();
    expect(await headers.allInnerTexts()).toEqual(headerTextBefore);
    // 3 rows x 2 columns (due, points).
    await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(6);
    await expect(dueCell(0)).toHaveAttribute("data-range", "true");
    await expect(pointsCell(2)).toHaveAttribute("data-range", "true");

    // 2. Esc collapses; Shift+ArrowDown extends from the active cell.
    await page.keyboard.press("Escape");
    await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(0);
    await dueCell(0).click({ position: { x: 2, y: 2 } });
    await expect(dueCell(0)).toBeFocused();
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(3);
    await expect(dueCell(2)).toHaveAttribute("aria-selected", "true");
    // The anchor keeps focus while the range grows.
    await expect(dueCell(0)).toBeFocused();

    // 3. Paste three dates over the three selected rows.
    await page.keyboard.press("Escape");
    const pasteSaves: Promise<unknown>[] = [1, 2, 3].map(() => page.waitForResponse(isTaskPatch));
    await pasteText(dueCell(0), "2031-03-01\n2031-03-02\n2031-03-03");
    await Promise.all(pasteSaves);
    await expect(dueCell(0)).toContainText("Mar 1, 2031");
    await expect(dueCell(1)).toContainText("Mar 2, 2031");
    await expect(dueCell(2)).toContainText("Mar 3, 2031");

    // 4. Ctrl+D fills the top value down the selected range.
    await dueCell(0).click({ position: { x: 2, y: 2 } });
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    const fillSaves: Promise<unknown>[] = [1, 2].map(() => page.waitForResponse(isTaskPatch));
    await page.keyboard.press("Control+d");
    await Promise.all(fillSaves);
    for (const index of [0, 1, 2]) await expect(dueCell(index)).toContainText("Mar 1, 2031");

    // 5. Persisted across a reload.
    await page.reload();
    await page.waitForLoadState("networkidle");
    const reloaded = page
      .getByRole("grid", { name: "Tasks" })
      .getByRole("row")
      .filter({ hasText: prefix });
    await expect(reloaded).toHaveCount(3);
    for (const index of [0, 1, 2]) {
      await expect(reloaded.nth(index).locator('[data-col="due"]')).toContainText("Mar 1, 2031");
    }
  });
});
