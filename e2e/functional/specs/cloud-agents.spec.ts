/**
 * Cloud agents (ADR "Cloud agents as first-class identities", phase 3).
 *
 * Journey: an administrator creates a shared cloud agent from Workspace > Agents -> it is listed there with its Cloud and
 * Shared badges -> its instructions are editable -> it can be made the workspace default and the choice survives a reload
 * -> it is offered by the task assignee picker (the add-task form) -> the chat's Agent menu lists it and names it as the
 * default -> the page still fits a 390px viewport.
 *
 * Requires COMPASS_AGENTS_ENABLED=1 on the dev server and migrations 098, 099 and 101 on compass_e2e (the global setup
 * applies the registered migrations). Creating the agent exercises the real server actions; only cleanup touches SQL.
 */
import { test, expect } from "../fixtures/index";
import pg from "pg";
import { randomUUID } from "node:crypto";

test("an admin creates a shared cloud agent that is listed, defaultable, assignable and selectable in chat", async ({ page, base }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Cloud agent tests require the dedicated local compass_e2e database");
  const pool = new pg.Pool({ connectionString: url.toString() });
  const suffix = randomUUID().slice(0, 8);
  const name = `Triage agent ${suffix}`;
  const taskTitle = `Cloud agent task ${suffix}`;
  try {
    await page.goto(`${base}/settings`);
    const heading = page.getByRole("heading", { name: "Workspace agents", exact: true });
    await heading.scrollIntoViewIfNeeded();

    // Create.
    await page.getByRole("button", { name: "New cloud agent" }).click();
    const form = page.getByRole("form", { name: "New cloud agent" });
    await form.getByLabel("Owner").selectOption("WORKSPACE");
    await form.getByLabel("Agent name").fill(name);
    await form.getByLabel("Instructions").fill("Label every new piece of feedback.");
    await form.getByRole("button", { name: "Create agent" }).click();
    await expect(page.getByText("Agent created and enabled in this workspace.")).toBeVisible({ timeout: 20_000 });

    // Listed with its kind and owner type.
    const row = page.locator("li").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText("Cloud", { exact: true })).toBeVisible();
    await expect(row.getByText("Shared", { exact: true }).first()).toBeVisible();

    // Edit instructions.
    await row.getByRole("button", { name: `Edit ${name}` }).click();
    const edit = page.getByRole("form", { name: `Edit ${name}` });
    await edit.getByLabel("Instructions").fill("Label feedback and link it to the nearest opportunity.");
    await edit.getByRole("button", { name: "Save agent" }).click();
    await expect(page.getByRole("form", { name: `Edit ${name}` })).toHaveCount(0, { timeout: 15_000 });
    await row.getByRole("button", { name: `Edit ${name}` }).click();
    await expect(page.getByRole("form", { name: `Edit ${name}` }).getByLabel("Instructions")).toHaveValue(/nearest opportunity/);
    await row.getByRole("button", { name: "Close" }).click();

    // Workspace default, persisted across a reload.
    await row.getByRole("button", { name: "Set as workspace default" }).click();
    await expect(row.getByText("Workspace default", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.locator("li").filter({ hasText: name }).getByText("Workspace default", { exact: true })).toBeVisible();

    // Assignable: the add-task form's assignee picker offers it.
    await page.goto(`${base}/tasks`);
    const todo = page.locator('[data-task-column="TODO"]');
    await todo.getByRole("button", { name: /Add task/i }).click();
    await page.getByLabel("Title", { exact: true }).fill(taskTitle);
    await page.getByLabel("Assignee (optional)").click();
    const option = page.getByRole("option", { name: new RegExp(name) });
    await expect(option).toBeVisible({ timeout: 15_000 });
    await option.click();
    await todo.getByRole("button", { name: "Add Task", exact: true }).click();
    await expect(todo.locator('[data-slot="card"]').filter({ hasText: taskTitle }).getByText(`Agent: ${name}`)).toBeVisible({ timeout: 15_000 });

    // Selectable in chat, named as the default.
    await page.goto(`${base}/agent`);
    const agentMenu = page.getByLabel("Agent", { exact: true });
    await expect(agentMenu).toBeVisible({ timeout: 15_000 });
    await expect(agentMenu.getByRole("option", { name: `Default (${name})` })).toHaveCount(1);
    await expect(agentMenu.getByRole("option", { name: `${name} (shared)` })).toHaveCount(1);
    await expect(agentMenu.getByRole("option", { name: "Compass Agent" })).toHaveCount(1);

    // Mobile: nothing overflows horizontally.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/settings`);
    await page.getByRole("heading", { name: "Workspace agents", exact: true }).scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    const ids = (await pool.query("SELECT id FROM compass_dev.agents WHERE name = $1", [name])).rows.map((r) => r.id);
    await pool.query("DELETE FROM compass_dev.tasks WHERE title = $1", [taskTitle]);
    if (ids.length) {
      await pool.query("DELETE FROM compass_dev.workspace_default_agents WHERE agent_id = ANY($1::uuid[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM compass_dev.user_default_agents WHERE agent_id = ANY($1::uuid[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM compass_dev.agent_tool_calls WHERE agent_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM compass_dev.agent_workspace_grants WHERE agent_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM compass_dev.agents WHERE id = ANY($1::uuid[])", [ids]);
    }
    await pool.end();
  }
});
