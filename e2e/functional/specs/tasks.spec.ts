/**
 * Tasks functional spec.
 *
 * Journey: create a task via the board's inline "Add task" form (TODO column)
 *          → confirm it appears → drag it to the IN_PROGRESS column → confirm
 *          the status change persisted → open its detail panel from the card
 *          title → follow "Open full page" to the detail route → link it to
 *          the seeded baseline opportunity from the Links section → reload →
 *          confirm the link persisted → add a subtask → confirm the subtask
 *          remains visible after reloading the detail page.
 *
 * Task cards now match every other entity card: the title is a `<button>` that
 * opens the shared slide-over detail panel, and the full page at /tasks/<id>
 * mounts the same TaskDetail component with no tabs — Subtasks, Links and
 * Details are plain stacked sections, so they're located directly.
 *
 * dnd-kit's PointerSensor needs real mouse movement (not a single jump) to
 * activate past its 8px activation-distance threshold, so the drag here is
 * simulated with page.mouse.move/down/up rather than Playwright's built-in
 * dragTo — same approach as roadmap-unscheduled-items.spec.ts.
 */
import { test, expect } from "../fixtures/index";
import type { Page } from "@playwright/test";

async function dragTo(page: Page, source: ReturnType<Page["locator"]>, targetBox: { x: number; y: number; width: number; height: number }) {
  // Each board column body is its own `overflow-y-auto` scroll region, and new
  // tasks are appended to the bottom of their column. Once a column holds more
  // cards than fit, the newest card sits outside the visible part of that
  // region — but `boundingBox()` still reports its geometric box and Playwright
  // still calls it visible, so nothing upstream catches it. Driving raw
  // pointer events at those coordinates presses on empty page: measured at a
  // 7-card TODO column, the handle's box was y=935 with a 720px-tall viewport
  // and `document.elementFromPoint` returned null, so no drag ever started and
  // the awaited server action never fired. Scroll the handle into its column's
  // view first, then measure — unlike Playwright's own actions, mouse.* does
  // no auto-scrolling.
  await source.scrollIntoViewIfNeeded();
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
      // The board moves optimistically during drag-over. Wait for the server
      // action before reloading, otherwise navigation can interrupt persistence.
      const moveResponse = page.waitForResponse((response) =>
        response.request().method() === "POST" &&
        Boolean(response.request().headers()["next-action"]) &&
        new URL(response.url()).pathname === `${base}/tasks`
      );
      await dragTo(page, dragHandle, inProgressColumnBox);
      const persistedMove = await moveResponse;
      expect(persistedMove.ok()).toBe(true);
      await persistedMove.finished();

      await expect(todoColumn.locator('[data-slot="card"]').filter({ hasText: taskTitle })).not.toBeVisible({ timeout: 10_000 });
      const inProgressColumn = page.locator('[data-task-column="IN_PROGRESS"]');
      await expect(inProgressColumn.locator('[data-slot="card"]').filter({ hasText: taskTitle })).toBeVisible({ timeout: 10_000 });

      // Reload and confirm the status change actually persisted server-side.
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(
        page.locator('[data-task-column="IN_PROGRESS"]').locator('[data-slot="card"]').filter({ hasText: taskTitle })
      ).toBeVisible({ timeout: 10_000 });

      // ── 4. Open the task's detail panel, then its full page ─────────────────
      // The card title is a button that opens the shared slide-over panel (the
      // same interaction every other entity card has). The full page is still
      // reachable from there via "Open full page" — exercise that click-through
      // rather than a bare goto, so the route hop stays covered.
      const panel = page.locator('[data-slot="sheet-content"]');
      await page
        .locator('[data-task-column="IN_PROGRESS"]')
        .locator('[data-slot="card"]')
        .filter({ hasText: taskTitle })
        .getByRole("button", { name: taskTitle })
        .click();
      await expect(page).toHaveURL(/detail=task/, { timeout: 15_000 });
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByRole("button", { name: taskTitle })).toBeVisible({ timeout: 15_000 });

      // Wait for the URL to actually change before asserting on content —
      // a client-side Next.js Link navigation can resolve "networkidle"
      // almost instantly (no new document load), racing the title
      // assertion against the client render.
      await panel.getByRole("link", { name: "Open full page" }).click();
      await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/, { timeout: 15_000 });
      await page.waitForLoadState("networkidle");
      // The shared detail renders its title as an inline-editable control, not
      // a heading — same as every other entity panel.
      await expect(page.getByRole("button", { name: taskTitle })).toBeVisible({ timeout: 15_000 });

      // ── 5. Link it to the seeded baseline opportunity ───────────────────────
      // No Links tab any more — the Links section is always on the page.
      await page.getByRole("button", { name: "Add link" }).click();
      const linkDialog = page.getByRole("dialog", { name: "Link to another item" });

      // Type defaults to Opportunity — pick the seeded baseline opportunity.
      await linkDialog.getByRole("combobox", { name: "Opportunity" }).click();
      await page.getByRole("option", { name: "E2E Baseline Opportunity" }).click();
      await linkDialog.getByRole("button", { name: "Link" }).click();

      await expect(linkDialog).toBeHidden();
      await expect(page.getByText("E2E Baseline Opportunity")).toBeVisible({ timeout: 10_000 });

      // Reload and confirm the link persisted.
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.getByText("E2E Baseline Opportunity")).toBeVisible({ timeout: 10_000 });

      // ── 6. Add a subtask and confirm the partial hierarchy renders it ──────
      // "Story points" used to live behind the Overview tab; it is now stacked
      // on the same surface as everything else.
      await expect(page.getByText("Story points")).toBeVisible();

      await page.getByRole("button", { name: "Add subtask" }).click();
      await page.getByPlaceholder("Subtask title").fill(subtaskTitle);
      await page.getByRole("button", { name: "Add", exact: true }).click();

      // Subtask rows are buttons that open that subtask's own panel.
      const subtaskRow = page.getByRole("button", { name: subtaskTitle });
      await expect(subtaskRow).toBeVisible({ timeout: 10_000 });
      // The count the Subtasks tab label used to carry now sits on the section
      // heading itself.
      await expect(page.getByText("Subtasks (1)", { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("subtasks-partial-hierarchy-desktop.png"), fullPage: true });

      // Reload to prove the row was persisted server-side and is still
      // rendered when the detail page supplies only direct children.
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.getByText("Subtasks (1)", { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("button", { name: subtaskTitle })).toBeVisible({ timeout: 10_000 });

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole("button", { name: subtaskTitle })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("subtasks-partial-hierarchy-mobile.png"), fullPage: true });
    }
  );
});
