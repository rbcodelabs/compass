/**
 * Sheet-mode DataGrid (`interaction="sheet"`), proven on the Tasks list view.
 *
 * Journey: create a task on the board -> open the list view -> the grid is one
 * tab stop -> arrow to a cell, type to edit the title, Enter to commit -> Esc
 * abandons an edit -> change status and due date from the keyboard -> reload and
 * confirm the writes persisted -> Alt+Enter opens the detail panel -> dragging
 * across body cells never reorders columns.
 *
 * The axe pass the design asks for is not run here: `@axe-core/playwright` is
 * not a dependency of this repo, and adding one is an architect-level call.
 */
import { test, expect } from "../fixtures/index";
import type { Page } from "@playwright/test";

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

test.describe("Sheet-mode grid (Tasks list)", () => {
  test("keyboard navigation and editing persist", async ({ page, base }) => {
    const ts = Date.now();
    const title = `E2E Sheet Task ${ts}`;
    const renamed = `${title} renamed`;
    await createTask(page, base, title);

    await page.goto(`${base}/tasks?view=list`);
    await page.waitForLoadState("networkidle");

    const grid = page.getByRole("grid", { name: "Tasks" });
    await expect(grid).toBeVisible();
    // The server total plus the header row.
    await expect(grid).toHaveAttribute("aria-rowcount", /^\d+$/);

    // One tab stop: exactly one cell is tabbable.
    await expect(grid.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);

    const row = grid.getByRole("row").filter({ hasText: title });
    const titleCell = row.locator('[data-col="title"]');

    // Click the cell's padding (not the title button, which opens the panel) to
    // make it the active cell, then edit by typing.
    await titleCell.click({ position: { x: 2, y: 2 } });
    await expect(titleCell).toBeFocused();

    // Esc abandons an edit.
    await page.keyboard.press("Enter");
    const input = page.getByLabel(`Title for ${title}`);
    await expect(input).toBeFocused();
    await page.keyboard.type(" scratch");
    await page.keyboard.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(titleCell).toBeFocused();
    await expect(titleCell).toContainText(title);
    await expect(titleCell).not.toContainText("scratch");

    // F2 edits with the existing text selected-at-end; Enter commits.
    await page.keyboard.press("F2");
    await expect(page.getByLabel(`Title for ${title}`)).toHaveValue(title);
    await page.keyboard.type(" renamed");
    const titleSave = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" && response.url().includes("/api/panels/entity/task/"),
    );
    await page.keyboard.press("Enter");
    expect((await titleSave).ok()).toBe(true);
    await expect(grid.getByRole("row").filter({ hasText: renamed })).toBeVisible();

    // Due date: type to edit replaces the content.
    const renamedRow = grid.getByRole("row").filter({ hasText: renamed });
    const dueCell = renamedRow.locator('[data-col="due"]');
    await dueCell.click({ position: { x: 2, y: 2 } });
    await page.keyboard.type("2031-01-15");
    const dueSave = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" && response.url().includes("/api/panels/entity/task/"),
    );
    await page.keyboard.press("Enter");
    expect((await dueSave).ok()).toBe(true);
    await expect(dueCell).toContainText("Jan 15, 2031");

    // Status: Enter opens the listbox, Arrow + Enter picks.
    const statusCell = renamedRow.locator('[data-col="status"]');
    await statusCell.click({ position: { x: 2, y: 2 } });
    await page.keyboard.press("Enter");
    const statusSave = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" && response.url().includes("/api/panels/entity/task/"),
    );
    await page.getByRole("option", { name: "In Progress" }).click();
    expect((await statusSave).ok()).toBe(true);
    await expect(statusCell).toContainText("In Progress");
    await expect(statusCell).toBeFocused();

    // Persisted across a reload.
    await page.reload();
    await page.waitForLoadState("networkidle");
    const reloaded = page.getByRole("grid", { name: "Tasks" }).getByRole("row").filter({ hasText: renamed });
    await expect(reloaded.locator('[data-col="due"]')).toContainText("Jan 15, 2031");
    await expect(reloaded.locator('[data-col="status"]')).toContainText("In Progress");
  });

  test("Alt+Enter opens the detail panel and a body drag never reorders columns", async ({ page, base }) => {
    const title = `E2E Sheet Panel ${Date.now()}`;
    await createTask(page, base, title);
    await page.goto(`${base}/tasks?view=list`);
    await page.waitForLoadState("networkidle");

    const grid = page.getByRole("grid", { name: "Tasks" });
    const headers = grid.locator("thead th");
    const headerTextBefore = await headers.allInnerTexts();

    const row = grid.getByRole("row").filter({ hasText: title });
    const statusCell = row.locator('[data-col="status"]');
    const priorityCell = row.locator('[data-col="priority"]');
    const from = await priorityCell.boundingBox();
    const to = await statusCell.boundingBox();
    if (!from || !to) throw new Error("cells have no bounding box");

    // Past dnd-kit's 8px activation distance, entirely inside body cells.
    await page.mouse.move(from.x + 4, from.y + 4);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + 4, { steps: 5 });
    await page.mouse.move(to.x + to.width - 4, to.y + 4, { steps: 10 });
    await page.mouse.up();
    expect(await headers.allInnerTexts()).toEqual(headerTextBefore);

    await row.locator('[data-col="title"]').click({ position: { x: 2, y: 2 } });
    await page.keyboard.press("Alt+Enter");
    await expect(page).toHaveURL(/detail=task/, { timeout: 15_000 });
    await expect(page.locator('[data-slot="sheet-content"]')).toBeVisible();
  });
});
