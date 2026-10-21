/**
 * Undo / redo on sheet-mode grids, and editing the customer segment and
 * description of existing Discovery opportunities.
 *
 * Tasks journey: create three tasks -> paste three due dates (one gesture) ->
 * Ctrl+Z restores all three in one step -> Ctrl+Shift+Z re-applies them -> the
 * toolbar buttons do the same -> the result persists across a reload.
 *
 * Discovery journey: create an opportunity through the draft area -> edit its
 * segment and description in place -> reload shows them -> Undo puts the
 * previous values back.
 *
 * Pastes are synthetic `ClipboardEvent("paste")`s: no clipboard permission needed.
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
const isOpportunityPatch = (response: { request(): { method(): string }; url(): string }) =>
  response.request().method() === "PATCH" && response.url().includes("/api/panels/entity/opportunity/");

test.describe("Sheet-mode undo / redo (Tasks list)", () => {
  test("one paste is one undo step; redo and the toolbar buttons replay it", async ({ page, base }) => {
    const prefix = `E2E Undo ${Date.now()}`;
    for (const suffix of ["a", "b", "c"]) await createTask(page, base, `${prefix} ${suffix}`);

    await page.goto(`${base}/tasks?view=list`);
    await page.waitForLoadState("networkidle");
    const grid = page.getByRole("grid", { name: "Tasks" });
    const rows = grid.getByRole("row").filter({ hasText: prefix });
    await expect(rows).toHaveCount(3);
    const dueCell = (index: number) => rows.nth(index).locator('[data-col="due"]');

    const undo = page.getByRole("button", { name: "Undo", exact: true });
    const redo = page.getByRole("button", { name: "Redo", exact: true });
    await expect(undo).toBeDisabled();

    // Paste three dates: three saves, ONE history step.
    await dueCell(0).click({ position: { x: 2, y: 2 } });
    let saves = [1, 2, 3].map(() => page.waitForResponse(isTaskPatch));
    await pasteText(dueCell(0), "2031-04-01\n2031-04-02\n2031-04-03");
    await Promise.all(saves);
    await expect(dueCell(2)).toContainText("Apr 3, 2031");
    await expect(undo).toBeEnabled();

    // Ctrl+Z restores all three through the same save path.
    saves = [1, 2, 3].map(() => page.waitForResponse(isTaskPatch));
    await dueCell(0).click({ position: { x: 2, y: 2 } });
    await page.keyboard.press("Control+z");
    await Promise.all(saves);
    for (const index of [0, 1, 2]) await expect(dueCell(index)).not.toContainText("2031");
    await expect(undo).toBeDisabled();
    await expect(redo).toBeEnabled();

    // Ctrl+Shift+Z re-applies the paste.
    saves = [1, 2, 3].map(() => page.waitForResponse(isTaskPatch));
    await page.keyboard.press("Control+Shift+z");
    await Promise.all(saves);
    await expect(dueCell(1)).toContainText("Apr 2, 2031");

    // The toolbar button undoes it again; Ctrl+Y redoes.
    saves = [1, 2, 3].map(() => page.waitForResponse(isTaskPatch));
    await undo.click();
    await Promise.all(saves);
    await expect(dueCell(1)).not.toContainText("2031");
    saves = [1, 2, 3].map(() => page.waitForResponse(isTaskPatch));
    await dueCell(0).click({ position: { x: 2, y: 2 } });
    await page.keyboard.press("Control+y");
    await Promise.all(saves);
    await expect(dueCell(2)).toContainText("Apr 3, 2031");

    // Persisted, and history does not survive a reload (new grid instance).
    await page.reload();
    await page.waitForLoadState("networkidle");
    const reloaded = page.getByRole("grid", { name: "Tasks" }).getByRole("row").filter({ hasText: prefix });
    await expect(reloaded.nth(2).locator('[data-col="due"]')).toContainText("Apr 3, 2031");
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  });
});

test.describe("Discovery: edit segment and description in place", () => {
  test("edits persist, and Undo restores the previous segment", async ({ page, base }) => {
    const title = `E2E Cells ${Date.now()}`;
    await page.goto(`${base}/discovery?view=table`);
    await page.waitForLoadState("networkidle");

    // Create the opportunity through the draft area (title + segment).
    await page.evaluate(
      ([text]) => {
        const inputs = document.querySelectorAll<HTMLInputElement>(
          '[data-testid="grid-draft-area"] input[aria-label^="Title for"]',
        );
        const target = inputs[inputs.length - 1];
        target.focus();
        const data = new DataTransfer();
        data.setData("text/plain", text);
        target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      },
      [`${title}\tOriginal segment\r\n`],
    );
    await page.getByTestId("draft-create").click();
    const row = page.locator('[data-row-id^="opportunity:"]').filter({ hasText: title });
    await expect(row).toHaveCount(1, { timeout: 15_000 });

    // Edit the segment: Enter, type, Enter.
    const segment = row.locator('[data-col="segment"]');
    await segment.click({ position: { x: 2, y: 2 } });
    await page.keyboard.press("Enter");
    let saved = page.waitForResponse(isOpportunityPatch);
    await page.keyboard.press("Control+a");
    await page.keyboard.type("Enterprise");
    await page.keyboard.press("Enter");
    expect((await saved).ok()).toBe(true);
    await expect(segment).toContainText("Enterprise");

    // Edit the description.
    const description = row.locator('[data-col="description"]');
    await description.click({ position: { x: 2, y: 2 } });
    await page.keyboard.press("Enter");
    saved = page.waitForResponse(isOpportunityPatch);
    await page.keyboard.type("Why this matters");
    await page.keyboard.press("Enter");
    expect((await saved).ok()).toBe(true);
    await expect(description).toContainText("Why this matters");

    await page.reload();
    await page.waitForLoadState("networkidle");
    const reloaded = page.locator('[data-row-id^="opportunity:"]').filter({ hasText: title });
    await expect(reloaded.locator('[data-col="segment"]')).toContainText("Enterprise");
    await expect(reloaded.locator('[data-col="description"]')).toContainText("Why this matters");

    // Undo in a fresh edit: change the segment again, then undo it.
    const again = reloaded.locator('[data-col="segment"]');
    await again.click({ position: { x: 2, y: 2 } });
    await page.keyboard.press("Enter");
    saved = page.waitForResponse(isOpportunityPatch);
    await page.keyboard.press("Control+a");
    await page.keyboard.type("SMB");
    await page.keyboard.press("Enter");
    await saved;
    saved = page.waitForResponse(isOpportunityPatch);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(again).toContainText("Enterprise");
  });
});
