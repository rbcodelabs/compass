import { randomUUID } from "node:crypto";
import { test, expect, fixture } from "./fixtures";

test("owner creates and updates an opportunity, solution and linked task with persisted relationships", async ({ page }) => {
  const f = fixture();
  const base = `/${f.orgSlug}/${f.workspaceSlug}`;
  const suffix = randomUUID().slice(0, 8);
  const opportunity = `Preview opportunity ${suffix}`;
  const updatedOpportunity = `${opportunity} updated`;
  const solution = `Preview solution ${suffix}`;
  const updatedSolution = `${solution} updated`;
  const task = `Preview task ${suffix}`;

  await page.goto(`${base}/discovery`);
  // "Add opportunity" opens the docked composer; submitting hands its slot to
  // the new opportunity. Close that so the rest of the flow starts from the
  // board, as it did with the old inline form.
  await page.getByRole("button", { name: /Add opportunity/i }).first().click();
  const composer = page.locator('[data-slot="opportunity-composer"]');
  await composer.getByLabel("Title", { exact: true }).fill(opportunity);
  await composer.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page).toHaveURL(/detail=opportunity%3A/);
  await page.getByRole("button", { name: "Close panel" }).first().click();
  await expect(page).not.toHaveURL(/detail=/);
  await page.getByRole("button", { name: opportunity, exact: true }).click();
  const panel = page.locator('[data-slot="sheet-content"]');
  await panel.getByText(opportunity, { exact: true }).click();
  await panel.getByRole("textbox", { name: "Edit title", exact: true }).fill(updatedOpportunity);
  await panel.getByRole("textbox", { name: "Edit title", exact: true }).press("Enter");
  await expect(panel.getByText(updatedOpportunity, { exact: true })).toBeVisible();

  await panel.getByRole("button", { name: "Add Solution", exact: true }).click();
  await panel.getByLabel("Title", { exact: true }).fill(solution);
  await panel.getByRole("button", { name: "Add Solution", exact: true }).click();
  await panel.getByRole("button", { name: new RegExp(solution) }).click();
  await expect(page).toHaveURL(/detail=solution/);
  await panel.getByText(solution, { exact: true }).click();
  await panel.getByRole("textbox", { name: "Edit title", exact: true }).fill(updatedSolution);
  await panel.getByRole("textbox", { name: "Edit title", exact: true }).press("Enter");
  await expect(panel.getByText(updatedSolution, { exact: true })).toBeVisible();
  await page.reload();
  await expect(panel.getByText(updatedSolution, { exact: true })).toBeVisible();
  await expect(panel.getByText(updatedOpportunity, { exact: true })).toBeVisible();

  await page.goto(`${base}/tasks`);
  const todo = page.locator('[data-task-column="TODO"]');
  await todo.getByRole("button", { name: /Add task/i }).click();
  await page.getByLabel("Title", { exact: true }).fill(task);
  await todo.getByRole("button", { name: "Add Task", exact: true }).click();
  await todo.getByRole("link", { name: task, exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  await page.getByRole("tab", { name: /Links/ }).click();
  await page.getByRole("button", { name: "Add link", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Type", { exact: true }).click();
  await page.getByRole("option", { name: "Solution", exact: true }).click();
  await dialog.getByRole("combobox").last().click();
  await page.getByRole("option", { name: updatedSolution, exact: true }).click();
  await dialog.getByRole("button", { name: "Link", exact: true }).click();
  await expect(page.getByText(updatedSolution, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: task, exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Links/ }).click();
  await expect(page.getByText(updatedSolution, { exact: true })).toBeVisible();
});

test.describe("least-privileged persona", () => {
  // Compass currently has ADMIN/MEMBER, not a read-only VIEWER role.
  test.use({ storageState: process.env.PREVIEW_VIEWER_STATE });

  test("member can read its workspace but cannot promote itself to admin", async ({ page }) => {
    const f = fixture();
    await page.goto(`/${f.orgSlug}/${f.workspaceSlug}/settings`);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    const memberRole = page.getByRole("combobox").filter({ hasText: "Member" });
    await expect(memberRole).toHaveCount(1);
    await memberRole.click();
    const rejectedMutation = page.waitForResponse(response =>
      response.request().method() === "POST" && response.request().headers()["next-action"] !== undefined
    );
    await page.getByRole("option", { name: "Admin", exact: true }).click();
    await rejectedMutation;
    // Error text is intentionally not coupled to Next's production redaction.
    // The optimistic selection must revert and remain unchanged after reload.
    await expect(page.getByRole("combobox").filter({ hasText: "Member" })).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole("combobox").filter({ hasText: "Member" })).toHaveCount(1);
  });

  test("member cannot navigate to another registered workspace", async ({ page }) => {
    const f = fixture();
    await page.goto(`/${f.orgSlug}/${f.workspaceSlug}/discovery`);
    await expect(page.getByRole("button", { name: /Add opportunity/i }).first()).toBeVisible();
    await page.goto(`/${f.orgSlug}/${f.isolatedWorkspaceSlug}/discovery`);
    // App-router streaming can return 200 for notFound(); assert rendered denial.
    await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Add opportunity/i })).toHaveCount(0);
  });
});

test.describe("unauthenticated boundary", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("workspace navigation redirects an unauthenticated browser to login", async ({ page }) => {
    const f = fixture();
    await page.goto(`/${f.orgSlug}/${f.workspaceSlug}/discovery`);
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
  });
});
