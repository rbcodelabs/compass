/**
 * Roadmap delivery-status functional spec.
 *
 * Proves the complete user-facing data flow: create a roadmap item, create
 * tasks in delivery columns, link them to that roadmap item from the task
 * detail UI, and observe the derived badge (including mixed-state precedence)
 * on the internal roadmap Board.
 */
import { test, expect } from "../fixtures/index";
import { openFullPage } from "../fixtures/full-page";
import type { Page } from "@playwright/test";

async function createAndLinkTask(
  page: Page,
  base: string,
  status: "IN_PROGRESS" | "BLOCKED",
  taskTitle: string,
  roadmapTitle: string,
) {
  await page.goto(`${base}/tasks`);
  await page.waitForLoadState("networkidle");

  const column = page.locator(`[data-task-column="${status}"]`);
  await column.getByRole("button", { name: /Add task/i }).click();
  await page.getByLabel("Title").fill(taskTitle);
  await column.getByRole("button", { name: "Add Task", exact: true }).click();

  const taskCard = column.locator('[data-slot="card"]').filter({ hasText: taskTitle });
  await expect(taskCard).toBeVisible({ timeout: 10_000 });
  await taskCard.getByRole("button", { name: taskTitle }).click();
  const taskPanel = page.locator('[data-slot="sheet-content"]');
  await expect(taskPanel).toBeVisible({ timeout: 15_000 });
  await openFullPage(page, taskPanel);

  await page.getByRole("button", { name: "Add link" }).click();
  const linkDialog = page.getByRole("dialog", { name: "Link to another item" });
  await linkDialog.getByRole("combobox", { name: "Search linkable items" }).fill(roadmapTitle);
  await linkDialog.getByRole("option", { name: `${roadmapTitle} Roadmap Item` }).click();
  await linkDialog.getByRole("button", { name: "Link item" }).click();

  // The selected combobox label is already visible while the action is pending.
  // This dialog closes only after linkTask has successfully persisted the link.
  await expect(page.getByRole("dialog", { name: "Link to another item" })).toBeHidden();
  // The visible link confirms the task-to-roadmap relationship persisted in
  // the task detail experience before the roadmap consumes it.
  await expect(page.getByText(roadmapTitle)).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await expect(page.getByText(roadmapTitle)).toBeVisible({ timeout: 10_000 });
}

test.describe("Roadmap delivery status", () => {
  test("derives status from linked tasks and applies mixed-state precedence", async ({ page, base }) => {
    const ts = Date.now();
    const roadmapTitle = `E2E Delivery Status ${ts}`;

    await page.goto(`${base}/roadmap`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Add item" }).nth(1).click();
    await page.getByLabel("Title").fill(roadmapTitle);
    await page.getByRole("button", { name: "Add Item", exact: true }).click();

    let roadmapCard = page.locator('[data-slot="card"]').filter({ hasText: roadmapTitle });
    await expect(roadmapCard).toBeVisible({ timeout: 10_000 });
    await expect(roadmapCard.getByLabel("Delivery status: Not Started")).toBeVisible();

    await createAndLinkTask(
      page,
      base,
      "IN_PROGRESS",
      `E2E In Progress ${ts}`,
      roadmapTitle,
    );

    await page.goto(`${base}/roadmap`);
    await page.waitForLoadState("networkidle");
    roadmapCard = page.locator('[data-slot="card"]').filter({ hasText: roadmapTitle });
    await expect(roadmapCard.getByLabel("Delivery status: In Development")).toBeVisible({ timeout: 10_000 });

    await createAndLinkTask(
      page,
      base,
      "BLOCKED",
      `E2E Blocked ${ts}`,
      roadmapTitle,
    );

    await page.goto(`${base}/roadmap`);
    await page.waitForLoadState("networkidle");
    roadmapCard = page.locator('[data-slot="card"]').filter({ hasText: roadmapTitle });
    await expect(roadmapCard.getByLabel("Delivery status: Blocked")).toBeVisible({ timeout: 10_000 });
    await expect(roadmapCard.getByLabel("Delivery status: In Development")).toHaveCount(0);
  });
});
