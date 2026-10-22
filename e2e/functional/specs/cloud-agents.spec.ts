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
import type { Page } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { E2E_USER_EMAIL } from "../fixtures/seed-e2e";

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

/**
 * Phase 4: assigning a task to a cloud agent starts an attributed run; an agent limit refuses the next one without
 * undoing the assignment.
 *
 * The sandbox cannot boot in this environment (no Vercel credentials, and the snapshot id below is a placeholder), so the
 * run is created, attributed and then fails to start: exactly what the spec asserts is the QUEUED -> terminal row and the
 * attribution, not an agent doing work. The deferred launch runs after the server action has answered, which is also why
 * the toast is checked before the row's final status. Needs ANTHROPIC_API_KEY set on the dev server (playwright.config.ts
 * sets a placeholder) and the placeholder snapshot row inserted here.
 */
async function createSharedAgent(page: Page, base: string, name: string) {
  await page.goto(`${base}/settings`);
  await page.getByRole("heading", { name: "Workspace agents", exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "New cloud agent" }).click();
  const form = page.getByRole("form", { name: "New cloud agent" });
  await form.getByLabel("Owner").selectOption("WORKSPACE");
  await form.getByLabel("Agent name").fill(name);
  await form.getByLabel("Instructions").fill("Summarise the task and say what you would do.");
  await form.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByText("Agent created and enabled in this workspace.")).toBeVisible({ timeout: 20_000 });
}

async function addTaskAssignedTo(page: Page, base: string, title: string, agentName: string) {
  await page.goto(`${base}/tasks`);
  const todo = page.locator('[data-task-column="TODO"]');
  await todo.getByRole("button", { name: /Add task/i }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Assignee (optional)").click();
  await page.getByRole("option", { name: new RegExp(agentName) }).click();
  await todo.getByRole("button", { name: "Add Task", exact: true }).click();
  await expect(todo.locator('[data-slot="card"]').filter({ hasText: title }).getByText(`Agent: ${agentName}`)).toBeVisible({ timeout: 15_000 });
}

test("assigning a task to a cloud agent starts an attributed run; a run limit refuses the next without undoing the assignment", async ({ page, base }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Cloud agent tests require the dedicated local compass_e2e database");
  const pool = new pg.Pool({ connectionString: url.toString() });
  const suffix = randomUUID().slice(0, 8);
  const name = `Run agent ${suffix}`;
  const firstTitle = `Run task one ${suffix}`;
  const secondTitle = `Run task two ${suffix}`;
  const toast = (text: string | RegExp) => page.getByTestId("undo-toast").filter({ hasText: text });
  const previousSnapshot = (await pool.query("SELECT golden_snapshot_id FROM compass_dev.agent_runtime_config WHERE scope = 'global'")).rows[0] as { golden_snapshot_id: string | null } | undefined;
  try {
    // The runtime prerequisite a real deployment has: a golden snapshot id. A placeholder is enough, since nothing boots it.
    await pool.query(
      `INSERT INTO compass_dev.agent_runtime_config (scope, golden_snapshot_id, updated_at) VALUES ('global', $1, now())
       ON CONFLICT (scope) DO UPDATE SET golden_snapshot_id = EXCLUDED.golden_snapshot_id, updated_at = now()`,
      ["e2e-placeholder-snapshot"],
    );
    await createSharedAgent(page, base, name);
    const agentId = (await pool.query("SELECT id FROM compass_dev.agents WHERE name = $1", [name])).rows[0].id as string;
    const userId = (await pool.query("SELECT id FROM compass_dev.users WHERE email = $1", [E2E_USER_EMAIL])).rows[0].id as string;

    // 1. Assigning starts a run, and the person is told.
    await addTaskAssignedTo(page, base, firstTitle, name);
    await expect(toast(`Started a run as ${name}.`)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await pool.query("SELECT count(*)::int AS n FROM compass_dev.agent_runs WHERE agent_id = $1", [agentId])).rows[0].n, { timeout: 20_000 }).toBe(1);
    const run = (await pool.query("SELECT user_id, invoked_by_user_id, kind, status, claim_id, conversation_id FROM compass_dev.agent_runs WHERE agent_id = $1", [agentId])).rows[0];
    expect(run.kind).toBe("TASK_ASSIGNMENT");
    expect(run.invoked_by_user_id).toBe(userId);
    expect(run.user_id).toBe(userId);
    // No claim blob: the run acts through the agent's own grants, not a claim-scoped credential.
    expect(run.claim_id).toBeNull();
    const conversation = (await pool.query("SELECT title, user_id, interview_processing_json FROM compass_dev.agent_conversations WHERE id = $1", [run.conversation_id])).rows[0];
    expect(conversation.title).toContain(firstTitle);
    expect(conversation.user_id).toBe(userId);
    expect(conversation.interview_processing_json).toBeNull();
    const asked = (await pool.query("SELECT role, content FROM compass_dev.agent_messages WHERE conversation_id = $1 ORDER BY created_at ASC", [run.conversation_id])).rows;
    expect(asked[0].role).toBe("user");
    expect(asked[0].content).toContain("get_task");
    // The sandbox cannot boot here, so the deferred launch ends the run as FAILED(RUN_START_FAILED), attribution intact.
    await expect.poll(async () => (await pool.query("SELECT status FROM compass_dev.agent_runs WHERE agent_id = $1", [agentId])).rows[0].status, { timeout: 60_000 }).not.toBe("QUEUED");

    // 2. Re-opening the board starts nothing more (a page load is not an assignment).
    await page.goto(`${base}/tasks`);
    await expect(page.locator('[data-slot="card"]').filter({ hasText: firstTitle })).toBeVisible();
    expect((await pool.query("SELECT count(*)::int AS n FROM compass_dev.agent_runs WHERE agent_id = $1", [agentId])).rows[0].n).toBe(1);

    // 3. An administrator caps the agent at one run a day through the edit form.
    await page.goto(`${base}/settings`);
    await page.getByRole("heading", { name: "Workspace agents", exact: true }).scrollIntoViewIfNeeded();
    const row = page.locator("li").filter({ hasText: name });
    await row.getByRole("button", { name: `Edit ${name}` }).click();
    const edit = page.getByRole("form", { name: `Edit ${name}` });
    await edit.getByLabel("Daily run limit").fill("1");
    await edit.getByRole("button", { name: "Save agent" }).click();
    await expect(page.getByRole("form", { name: `Edit ${name}` })).toHaveCount(0, { timeout: 15_000 });
    expect((await pool.query("SELECT max_runs_per_day, max_concurrent_runs FROM compass_dev.agents WHERE id = $1", [agentId])).rows[0]).toEqual({ max_runs_per_day: 1, max_concurrent_runs: null });
    await row.getByRole("button", { name: `Edit ${name}` }).click();
    await expect(page.getByRole("form", { name: `Edit ${name}` }).getByLabel("Daily run limit")).toHaveValue("1");

    // 4. The next assignment is saved, no second run starts, and the person is told which limit stopped it.
    await addTaskAssignedTo(page, base, secondTitle, name);
    await expect(toast(/no run started.*daily limit of 1 runs/)).toBeVisible({ timeout: 20_000 });
    expect((await pool.query("SELECT count(*)::int AS n FROM compass_dev.agent_runs WHERE agent_id = $1", [agentId])).rows[0].n).toBe(1);
    const second = (await pool.query("SELECT assignee_agent_id FROM compass_dev.tasks WHERE title = $1", [secondTitle])).rows[0];
    expect(second.assignee_agent_id).toBe(agentId);
  } finally {
    const ids = (await pool.query("SELECT id FROM compass_dev.agents WHERE name = $1", [name])).rows.map((r) => r.id);
    if (ids.length) {
      const conversations = (await pool.query("SELECT DISTINCT conversation_id FROM compass_dev.agent_runs WHERE agent_id = ANY($1::uuid[])", [ids])).rows.map((r) => r.conversation_id);
      if (conversations.length) {
        await pool.query("DELETE FROM compass_dev.agent_run_events WHERE run_id IN (SELECT id FROM compass_dev.agent_runs WHERE agent_id = ANY($1::uuid[]))", [ids]).catch(() => undefined);
        await pool.query("DELETE FROM compass_dev.agent_runs WHERE agent_id = ANY($1::uuid[])", [ids]);
        await pool.query("DELETE FROM compass_dev.agent_messages WHERE conversation_id = ANY($1::uuid[])", [conversations]);
        await pool.query("DELETE FROM compass_dev.agent_conversations WHERE id = ANY($1::uuid[])", [conversations]);
      }
      await pool.query("DELETE FROM compass_dev.api_keys WHERE agent_id = ANY($1::uuid[])", [ids]);
    }
    await pool.query("DELETE FROM compass_dev.tasks WHERE title = ANY($1::text[])", [[firstTitle, secondTitle]]);
    if (ids.length) {
      await pool.query("DELETE FROM compass_dev.workspace_default_agents WHERE agent_id = ANY($1::uuid[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM compass_dev.agent_tool_calls WHERE agent_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM compass_dev.agent_workspace_grants WHERE agent_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM compass_dev.agents WHERE id = ANY($1::uuid[])", [ids]);
    }
    if (previousSnapshot) await pool.query("UPDATE compass_dev.agent_runtime_config SET golden_snapshot_id = $1 WHERE scope = 'global'", [previousSnapshot.golden_snapshot_id]);
    else await pool.query("DELETE FROM compass_dev.agent_runtime_config WHERE scope = 'global'");
    await pool.end();
  }
});

/**
 * A 120-character agent name (the maximum) on a 390px phone. Lists wrap or scroll, never squash or clip: neither the page nor
 * any control may extend past the viewport, in the agents list, its edit form, or the assignee picker.
 */
test("a 120-character agent name does not overflow the page, the agent list or the assignee picker at 390px", async ({ page, base }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Cloud agent tests require the dedicated local compass_e2e database");
  const pool = new pg.Pool({ connectionString: url.toString() });
  const suffix = randomUUID().slice(0, 8);
  const name = `${suffix}-${"W".repeat(120 - suffix.length - 1)}`;
  expect(name).toHaveLength(120);
  const pageFits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const insideViewport = (locator: ReturnType<Page["locator"]>) => locator.evaluateAll((els) => els.every((el) => { const r = el.getBoundingClientRect(); return r.width === 0 || (r.left >= 0 && r.right <= window.innerWidth); }));
  try {
    await createSharedAgent(page, base, name);
    await page.goto(`${base}/settings`);
    const row = page.locator("li").filter({ hasText: name });
    await row.scrollIntoViewIfNeeded();
    await row.getByRole("button", { name: "Set as workspace default" }).click();
    await expect(row.getByText("Workspace default", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect.poll(pageFits).toBe(true);
    expect(await insideViewport(row.getByRole("button"))).toBe(true);

    // The edit form and its run-limit fields.
    await row.getByRole("button", { name: `Edit ${name}` }).click();
    await expect(page.getByRole("form", { name: `Edit ${name}` })).toBeVisible();
    await expect.poll(pageFits).toBe(true);
    expect(await insideViewport(row.locator("button, input, select, textarea"))).toBe(true);

    // The assignee picker's option for the agent is clipped inside the popup, with an ellipsis, not wider than the screen.
    await page.goto(`${base}/tasks`);
    await page.locator('[data-task-column="TODO"]').getByRole("button", { name: /Add task/i }).click();
    await page.getByLabel("Assignee (optional)").click();
    const option = page.getByRole("option", { name: new RegExp(suffix) });
    await expect(option).toBeVisible({ timeout: 15_000 });
    expect(await insideViewport(option)).toBe(true);
    expect(await option.locator("span").first().evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
    await expect.poll(pageFits).toBe(true);
  } finally {
    const ids = (await pool.query("SELECT id FROM compass_dev.agents WHERE name = $1", [name])).rows.map((r) => r.id);
    if (ids.length) {
      await pool.query("DELETE FROM compass_dev.workspace_default_agents WHERE agent_id = ANY($1::uuid[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM compass_dev.agent_tool_calls WHERE agent_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM compass_dev.agent_workspace_grants WHERE agent_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM compass_dev.agents WHERE id = ANY($1::uuid[])", [ids]);
    }
    await pool.end();
  }
});
