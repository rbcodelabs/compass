/**
 * Tasks functional spec.
 *
 * Journey: create a task via the board's inline "Add task" form (TODO column)
 *          → confirm it appears → drag it to the IN_PROGRESS column → confirm
 *          the status change persisted → open its detail page → link it to
 *          the seeded baseline opportunity from the Links tab → reload →
 *          confirm the link persisted → add a subtask → confirm the subtask
 *          remains visible after reloading the detail page.
 *
 * dnd-kit's PointerSensor needs real mouse movement (not a single jump) to
 * activate past its 8px activation-distance threshold, so the drag here is
 * simulated with page.mouse.move/down/up rather than Playwright's built-in
 * dragTo — same approach as roadmap-unscheduled-items.spec.ts.
 */
import { test, expect } from "../fixtures/index";
import type { Page } from "@playwright/test";

async function dragTo(page: Page, source: ReturnType<Page["locator"]>, targetBox: { x: number; y: number; width: number; height: number }) {
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error("drag source has no bounding box");

  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 15, startY + 15, { steps: 5 });
  await page.mouse.move(endX, endY, { steps: 15 });
  await page.mouse.up();
}

test.describe("Tasks", () => {
  test(
    "create task → drag to a new status column → link to an opportunity → persisted subtask",
    async ({ page, base }, testInfo) => {
      const ts = Date.now();
      const taskTitle = `E2E Task ${ts}`;
      const subtaskTitle = `E2E Subtask ${ts}`;

      // ── 1. Navigate to the Tasks board ──────────────────────────────────────
      await page.goto(`${base}/tasks`);
      await page.waitForLoadState("networkidle");

      // ── 2. Create a task in the TODO column via its inline add form ────────
      // `data-task-column` wraps the header + drop-zone + add-form for a
      // status column; the plain `#task-column-<STATUS>` id (used below for
      // drop-target boundingBox) covers only the drop zone itself.
      const todoColumn = page.locator('[data-task-column="TODO"]');
      await todoColumn.getByRole("button", { name: /Add task/i }).click();
      await page.getByLabel("Title").fill(taskTitle);
      await todoColumn.getByRole("button", { name: "Add Task", exact: true }).click();

      const taskCard = todoColumn.locator('[data-slot="card"]').filter({ hasText: taskTitle });
      await expect(taskCard).toBeVisible({ timeout: 10_000 });

      // ── 3. Drag the card into IN_PROGRESS ───────────────────────────────────
      const dragHandle = taskCard.getByLabel("Drag to reorder");
      const inProgressColumnBox = await page.locator("#task-column-IN_PROGRESS").boundingBox();
      if (!inProgressColumnBox) throw new Error("IN_PROGRESS column not found");
      await dragTo(page, dragHandle, inProgressColumnBox);

      await expect(todoColumn.locator('[data-slot="card"]').filter({ hasText: taskTitle })).not.toBeVisible({ timeout: 10_000 });
      const inProgressColumn = page.locator('[data-task-column="IN_PROGRESS"]');
      await expect(inProgressColumn.locator('[data-slot="card"]').filter({ hasText: taskTitle })).toBeVisible({ timeout: 10_000 });

      // Reload and confirm the status change actually persisted server-side.
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(
        page.locator('[data-task-column="IN_PROGRESS"]').locator('[data-slot="card"]').filter({ hasText: taskTitle })
      ).toBeVisible({ timeout: 10_000 });

      // ── 4. Open the task's detail page ──────────────────────────────────────
      // Wait for the URL to actually change before asserting on content —
      // a client-side Next.js Link navigation can resolve "networkidle"
      // almost instantly (no new document load), racing the heading
      // assertion against the client render.
      await page
        .locator('[data-task-column="IN_PROGRESS"]')
        .locator('[data-slot="card"]')
        .filter({ hasText: taskTitle })
        .getByRole("link", { name: taskTitle })
        .click();
      await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/, { timeout: 15_000 });
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { name: taskTitle })).toBeVisible({ timeout: 15_000 });

      // ── 5. Link it to the seeded baseline opportunity ───────────────────────
      await page.getByRole("tab", { name: /Links/ }).click();
      await page.getByRole("button", { name: "Add link" }).click();

      // Type defaults to Opportunity — pick the seeded baseline opportunity.
      await page.getByRole("combobox").last().click();
      await page.getByRole("option", { name: "E2E Baseline Opportunity" }).click();
      await page.getByRole("button", { name: "Link" }).click();

      await expect(page.getByText("E2E Baseline Opportunity")).toBeVisible({ timeout: 10_000 });

      // Reload and confirm the link persisted.
      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.getByRole("tab", { name: /Links/ }).click();
      await expect(page.getByText("E2E Baseline Opportunity")).toBeVisible({ timeout: 10_000 });

      // ── 6. Add a subtask and confirm the partial hierarchy renders it ──────
      await page.getByRole("tab", { name: "Overview" }).click();
      await expect(page.getByText("Story points")).toBeVisible();

      await page.getByRole("tab", { name: /Subtasks/ }).click();
      await page.getByRole("button", { name: "Add subtask" }).click();
      await page.getByPlaceholder("Subtask title").fill(subtaskTitle);
      await page.getByRole("button", { name: "Add", exact: true }).click();

      await expect(page.getByRole("link", { name: subtaskTitle })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("tab", { name: "Subtasks (1)" })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("subtasks-partial-hierarchy-desktop.png"), fullPage: true });

      // Reload/reopen Subtasks to prove the row was persisted server-side and
      // is still rendered when the detail page supplies only direct children.
      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.getByRole("tab", { name: "Subtasks (1)" }).click();
      await expect(page.getByRole("link", { name: subtaskTitle })).toBeVisible({ timeout: 10_000 });

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole("link", { name: subtaskTitle })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("subtasks-partial-hierarchy-mobile.png"), fullPage: true });
    }
  );
});
