import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

async function fits(container: Locator) {
  // Inline editors intentionally extend their hover target 4px into page padding.
  // Check the viewport separately so that allowance cannot hide real page overflow.
  await expect.poll(() => container.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await expect.poll(() => container.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.scrollWidth <= element.clientWidth + 4 ? [] : Array.from(element.querySelectorAll("*")).filter(child => child.getBoundingClientRect().right > box.right + 4).map(child => ({ tag: child.tagName, text: child.textContent?.slice(0, 80), width: child.getBoundingClientRect().width }));
  })).toEqual([]);
}

async function capture(page: Page, name: string) {
  await expect(page.getByText("Loading discussion…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Post comment", exact: true })).toBeVisible();
  // Hide only development-tool chrome; do not mask application content/errors.
  await page.screenshot({ path: `public/screenshots/docs/task-compact-${name}.png`, fullPage: true, style: "nextjs-portal { display: none !important; }" });
}

test("compact task detail preserves editing and fits overlay, pinned, mobile and full-page layouts", async ({ page, base }) => {
  test.setTimeout(180_000);
  const database = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(database.hostname) || database.pathname !== "/compass_e2e") {
    throw new Error("Compact layout tests require the dedicated local compass_e2e database");
  }
  const pool = new pg.Pool({ connectionString: database.toString() });
  const taskId = randomUUID();
  const fieldId = randomUUID();
  const title = "Design concierge validation — weekly stakeholder digest";
  try {
    const workspace = (await pool.query("SELECT id FROM compass_dev.workspaces WHERE slug='e2e-workspace'")).rows[0];
    await pool.query("INSERT INTO compass_dev.tasks (id, workspace_id, title, description, iteration, story_points, owner_name) VALUES ($1,$2,$3,$4,$5,$6,$7)", [taskId, workspace.id, title, "Summarize reader feedback and validate the next weekly digest with the product team.", "Sprint 24", 5, "External research partner"]);
    await pool.query("INSERT INTO compass_dev.custom_field_definitions (id, workspace_id, object_type, name, field_type) VALUES ($1,$2,'TASK','Research segment','TEXT')", [fieldId, workspace.id]);
    await pool.query("INSERT INTO compass_dev.custom_field_values (field_id,object_id,value) VALUES ($1,$2,$3::jsonb)", [fieldId, taskId, JSON.stringify("Weekly readers")]);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/tasks?detail=task:${taskId}`);
    const sheet = page.locator('[data-slot="sheet-content"]');
    const detail = page.locator('[data-slot="task-detail"]');
    await expect(sheet.getByRole("button", { name: title, exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "More properties" })).toHaveAttribute("aria-expanded", "false");
    await expect(sheet.getByText("No subtasks yet.")).toHaveCount(0);
    await expect(sheet.getByText("Subtasks", { exact: true })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Add subtask", exact: true })).toBeInViewport();
    const header = sheet.locator('[data-slot="sheet-header"]');
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(48);
    await expect(header.getByRole("link", { name: "Open full page" })).toBeVisible();
    await fits(detail);
    await capture(page, "overlay-desktop");

    await sheet.getByRole("button", { name: "More properties" }).click();
    await expect(sheet.getByText("Story points", { exact: true })).toBeVisible();
    await sheet.getByRole("button", { name: "External research partner", exact: true }).click();
    const ownerInput = sheet.getByRole("textbox", { name: "Edit ownerName" });
    await ownerInput.fill("Research partner team");
    await ownerInput.press("Enter");
    await expect(sheet.getByRole("button", { name: "Research partner team", exact: true })).toBeVisible();
    await sheet.getByRole("button", { name: "Weekly readers", exact: true }).click();
    await sheet.locator('input[type="text"]').fill("Engaged weekly readers");
    await sheet.locator('input[type="text"]').press("Enter");
    await expect(sheet.getByRole("button", { name: "Engaged weekly readers", exact: true })).toBeVisible();
    await sheet.getByRole("button", { name: "Due date: not set" }).click();
    const dateInput = sheet.getByLabel("Edit dueDate");
    await dateInput.fill("2026-10-02");
    await dateInput.press("Enter");
    await expect(sheet.getByRole("button", { name: "Due date: Oct 2, 2026" })).toBeVisible();
    await sheet.getByRole("combobox", { name: "Priority", exact: true }).click();
    await page.getByRole("option", { name: "High", exact: true }).click();
    await expect(sheet.getByRole("combobox", { name: "Priority", exact: true })).toContainText("High");
    await capture(page, "properties-desktop");

    await sheet.getByRole("button", { name: "Pin panel", exact: true }).click();
    const pinned = page.locator('[data-slot="pinned-panel"]');
    await expect(pinned).toBeVisible();
    await expect(pinned.getByRole("link", { name: "Open full page" })).toBeVisible();
    await fits(detail);
    await capture(page, "pinned-desktop");
    // A new document also proves all edits survive a server read.
    await page.context().addCookies([{ name: "compass_panel_detail", value: "1:320", domain: "localhost", path: "/" }]);
    await page.reload();
    await expect(pinned.getByRole("button", { name: "Research partner team", exact: true })).toBeVisible();
    await expect(pinned.getByRole("button", { name: "Engaged weekly readers", exact: true })).toBeVisible();
    await expect(pinned.getByRole("button", { name: "Due date: Oct 2, 2026" })).toBeVisible();
    await expect(pinned.getByRole("combobox", { name: "Priority", exact: true })).toContainText("High");
    await fits(detail);
    await capture(page, "pinned-narrow");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(sheet).toBeVisible();
    await expect(pinned).toHaveCount(0);
    await fits(detail);
    await capture(page, "overlay-mobile");
    await page.setViewportSize({ width: 320, height: 740 });
    await fits(detail);
    await capture(page, "overlay-320");
    await sheet.getByRole("link", { name: "Open full page" }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible();
    await fits(detail);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, "fullpage-mobile");
    await page.setViewportSize({ width: 1280, height: 800 });
    await capture(page, "fullpage-desktop");
  } finally {
    await pool.query("DELETE FROM compass_dev.custom_field_values WHERE field_id=$1", [fieldId]);
    await pool.query("DELETE FROM compass_dev.custom_field_definitions WHERE id=$1", [fieldId]);
    await pool.query("DELETE FROM compass_dev.tasks WHERE id=$1", [taskId]);
    await pool.end();
  }
});
