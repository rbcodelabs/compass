import { test, expect } from "../fixtures/index";
import pg from "pg";
import { randomUUID } from "node:crypto";

test("task agent assignment persists, filters, replaces a human and survives suspension", async ({ page, base }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Task agent tests require the dedicated local compass_e2e database");
  const pool = new pg.Pool({ connectionString: url.toString() });
  const agentId = randomUUID();
  const name = `Assignment agent ${agentId.slice(0, 8)}`;
  const title = `Agent task ${agentId.slice(0, 8)}`;
  let taskId: string | undefined;
  try {
    const user = (await pool.query("SELECT id,name,email FROM compass_dev.users WHERE email='dev@localhost.dev'")).rows[0];
    const workspace = (await pool.query("SELECT id FROM compass_dev.workspaces WHERE slug='e2e-workspace'")).rows[0];
    await pool.query("INSERT INTO compass_dev.agents (id,owner_user_id,name) VALUES ($1,$2,$3)", [agentId, user.id, name]);
    await pool.query("INSERT INTO compass_dev.agent_workspace_grants (agent_id,workspace_id,access,granted_by_user_id) VALUES ($1,$2,'WRITE',$3)", [agentId, workspace.id, user.id]);
    await page.goto(`${base}/tasks`);
    const todo = page.locator('[data-task-column="TODO"]');
    await todo.getByRole("button", { name: /Add task/i }).click();
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByLabel("Assignee (optional)").click();
    await page.getByRole("option", { name: new RegExp(name) }).click();
    await todo.getByRole("button", { name: "Add Task", exact: true }).click();
    const card = todo.locator('[data-slot="card"]').filter({ hasText: title });
    await expect(card.getByText(`Agent: ${name}`)).toBeVisible();
    await card.getByRole("link", { name: title }).click();
    await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
    taskId = page.url().split("/").pop();
    await page.reload();
    await expect(page.getByText(`Assignee: Agent: ${name}`)).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editBounds = await page.getByRole("dialog", { name: "Edit task" }).boundingBox();
    for (const field of [page.getByLabel("Title", { exact: true }), page.getByLabel("Assignee", { exact: true })]) {
      const bounds = await field.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(editBounds!.x + editBounds!.width);
    }
    await page.getByLabel("Assignee", { exact: true }).click();
    await expect(page.getByRole("option", { name: new RegExp(name) })).toBeVisible();
    if (process.env.COMPASS_CAPTURE_AGENT_DOCS === "1") await page.screenshot({ path: "public/screenshots/docs/tasks-agents-desktop.png", fullPage: true });
    await page.getByRole("option", { name: `People · ${user.name || user.email}`, exact: true }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog", { name: "Edit task" })).not.toBeVisible();
    expect((await pool.query("SELECT assignee_user_id,assignee_agent_id FROM compass_dev.tasks WHERE id=$1", [taskId])).rows[0]).toEqual({ assignee_user_id: user.id, assignee_agent_id: null });

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Assignee", { exact: true }).click();
    await page.getByRole("option", { name: new RegExp(name) }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog", { name: "Edit task" })).not.toBeVisible();
    await page.goto(`${base}/tasks?view=list&assignee=agent:${agentId}`);
    await expect(page.getByRole("link", { name: title })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("agent-assignment-desktop.png"), fullPage: true });
    await pool.query("UPDATE compass_dev.agents SET status='SUSPENDED' WHERE id=$1", [agentId]);
    await page.goto(`${base}/tasks/${taskId}`);
    await expect(page.getByText(`Assignee: Agent: ${name} (unavailable)`)).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill(`${title} retained`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog", { name: "Edit task" })).not.toBeVisible();
    expect((await pool.query("SELECT assignee_agent_id FROM compass_dev.tasks WHERE id=$1", [taskId])).rows[0].assignee_agent_id).toBe(agentId);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("agent-unavailable-mobile.png"), fullPage: true });
    if (process.env.COMPASS_CAPTURE_AGENT_DOCS === "1") await page.screenshot({ path: "public/screenshots/docs/tasks-agents-mobile.png", fullPage: true });
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const mobileDialog = page.getByRole("dialog", { name: "Edit task" });
    const mobileBounds = await mobileDialog.boundingBox();
    expect(mobileBounds!.x).toBeGreaterThanOrEqual(0);
    expect(mobileBounds!.x + mobileBounds!.width).toBeLessThanOrEqual(390);
    await page.getByLabel("Assignee", { exact: true }).click();
    await expect(page.getByRole("option", { name: new RegExp(name) })).toBeVisible();
    if (process.env.COMPASS_CAPTURE_AGENT_DOCS === "1") await page.screenshot({ path: "public/screenshots/docs/tasks-agents-picker-mobile.png", fullPage: true });
  } finally {
    if (taskId) await pool.query("DELETE FROM compass_dev.tasks WHERE id=$1", [taskId]);
    await pool.query("DELETE FROM compass_dev.agent_workspace_grants WHERE agent_id=$1", [agentId]);
    await pool.query("DELETE FROM compass_dev.agents WHERE id=$1", [agentId]);
    await pool.end();
  }
});
