/**
 * Task agent-assignment functional spec.
 *
 * Journey is unchanged: assign a personal agent from the board's add form →
 * confirm the card and the task detail both name the agent → replace it with a
 * human → confirm the DB columns swapped → put the agent back → confirm the
 * `?assignee=agent:<id>` filter isolates the task → suspend the agent →
 * confirm the detail marks it unavailable, that an unrelated edit does not
 * silently drop the assignment, and that the whole surface still fits a
 * 390px viewport.
 *
 * What changed is only how the detail is reached and edited: the card title is
 * a `<button>` that opens the shared slide-over panel (matching every other
 * entity card), there is no "Edit task" dialog any more, and every field is
 * edited inline through the panel's PATCH endpoint.
 *
 * Requires COMPASS_AGENTS_ENABLED=1 on the dev server — without it
 * `eligibleTaskAssignees` returns people only and no agent option is ever
 * offered.
 */
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

  const panel = page.locator('[data-slot="sheet-content"]');
  const assigneePicker = () => page.getByRole("combobox", { name: "Assignee", exact: true });
  // Inline edits persist through the panel's PATCH route — wait for the write
  // to land before asserting on the database, the way the old dialog's "Save
  // changes" click used to give us a natural barrier.
  const savedField = () =>
    page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      response.url().includes("/api/panels/entity/task/") &&
      response.ok()
    );
  // The Sheet slides in from a 2.5rem translate, and `toBeVisible()` resolves
  // while that transition is still running — measuring then reports a
  // mid-animation box rather than the resting one. Poll until the left edge
  // stops moving before taking any geometry off the panel.
  const settledPanelBox = async () => {
    let previous = Number.NaN;
    await expect
      .poll(
        async () => {
          const box = await panel.boundingBox();
          if (!box) return false;
          const x = Math.round(box.x);
          const stable = x === previous;
          previous = x;
          return stable;
        },
        { timeout: 15_000 }
      )
      .toBe(true);
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    return box!;
  };

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

    // The card title opens the shared detail panel; the task id lives in the
    // `detail=task:<id>` panel param rather than the pathname.
    await card.getByRole("button", { name: title }).click();
    await expect(page).toHaveURL(/detail=task/, { timeout: 15_000 });
    await expect(panel).toBeVisible({ timeout: 15_000 });
    taskId = new URL(page.url()).searchParams.get("detail")!.split(":")[1];

    // Reload: the panel is URL-driven, so it reopens on the same task and must
    // still name the agent — the same persistence check the old detail page
    // header ("Assignee: Agent: …") made.
    await page.reload();
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole("combobox", { name: "Assignee", exact: true })).toContainText(`Agents · ${name}`, { timeout: 15_000 });

    // Nothing in the edit surface may overflow its container — the assertion
    // the old "Edit task" dialog's bounding box carried, now made against the
    // panel that replaced it.
    const panelBounds = await settledPanelBox();
    for (const field of [panel.getByRole("button", { name: title }), panel.getByRole("combobox", { name: "Assignee", exact: true })]) {
      const bounds = await field.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(panelBounds.x + panelBounds.width);
    }

    // ── Replace the agent with a human, inline ──────────────────────────────
    await assigneePicker().click();
    await expect(page.getByRole("option", { name: new RegExp(name) })).toBeVisible();
    if (process.env.COMPASS_CAPTURE_AGENT_DOCS === "1") await page.screenshot({ path: "public/screenshots/docs/tasks-agents-desktop.png", fullPage: true });
    const humanSaved = savedField();
    await page.getByRole("option", { name: `People · ${user.name || user.email}`, exact: true }).click();
    await humanSaved;
    expect((await pool.query("SELECT assignee_user_id,assignee_agent_id FROM compass_dev.tasks WHERE id=$1", [taskId])).rows[0]).toEqual({ assignee_user_id: user.id, assignee_agent_id: null });

    // ── …and hand it back to the agent ──────────────────────────────────────
    await assigneePicker().click();
    const agentSaved = savedField();
    await page.getByRole("option", { name: new RegExp(name) }).click();
    await agentSaved;
    expect((await pool.query("SELECT assignee_user_id,assignee_agent_id FROM compass_dev.tasks WHERE id=$1", [taskId])).rows[0]).toEqual({ assignee_user_id: null, assignee_agent_id: agentId });

    await page.goto(`${base}/tasks?view=list&assignee=agent:${agentId}`);
    await expect(page.getByRole("button", { name: title })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("agent-assignment-desktop.png"), fullPage: true });

    // ── Suspend the agent: the assignment survives and is marked unavailable ─
    await pool.query("UPDATE compass_dev.agents SET status='SUSPENDED' WHERE id=$1", [agentId]);
    await page.goto(`${base}/tasks/${taskId}`);
    await expect(page.getByRole("combobox", { name: "Assignee", exact: true })).toContainText(
      new RegExp(`Agents · ${name}.*\\(unavailable\\)`),
      { timeout: 15_000 }
    );

    // An unrelated inline edit must not silently drop the suspended agent —
    // the same guarantee the old "change the title, press Save changes" step
    // checked through the dialog.
    await page.getByRole("button", { name: title }).click();
    const titleInput = page.getByRole("textbox", { name: "Edit title" });
    await titleInput.fill(`${title} retained`);
    await titleInput.press("Enter");
    await expect(page.getByRole("button", { name: `${title} retained` })).toBeVisible({ timeout: 15_000 });
    expect((await pool.query("SELECT assignee_agent_id FROM compass_dev.tasks WHERE id=$1", [taskId])).rows[0].assignee_agent_id).toBe(agentId);

    // ── Mobile: the detail surface fits, and still offers the agent ──────────
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("combobox", { name: "Assignee", exact: true })).toContainText("(unavailable)");
    await page.screenshot({ path: testInfo.outputPath("agent-unavailable-mobile.png"), fullPage: true });
    if (process.env.COMPASS_CAPTURE_AGENT_DOCS === "1") await page.screenshot({ path: "public/screenshots/docs/tasks-agents-mobile.png", fullPage: true });

    await page.goto(`${base}/tasks?view=list&assignee=agent:${agentId}`);
    await page.getByRole("button", { name: `${title} retained` }).click();
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const mobileBounds = await settledPanelBox();
    expect(mobileBounds.x).toBeGreaterThanOrEqual(0);
    expect(mobileBounds.x + mobileBounds.width).toBeLessThanOrEqual(390);
    await panel.getByRole("combobox", { name: "Assignee", exact: true }).click();
    await expect(page.getByRole("option", { name: new RegExp(name) })).toBeVisible();
    if (process.env.COMPASS_CAPTURE_AGENT_DOCS === "1") await page.screenshot({ path: "public/screenshots/docs/tasks-agents-picker-mobile.png", fullPage: true });
  } finally {
    if (taskId) await pool.query("DELETE FROM compass_dev.tasks WHERE id=$1", [taskId]);
    await pool.query("DELETE FROM compass_dev.agent_workspace_grants WHERE agent_id=$1", [agentId]);
    await pool.query("DELETE FROM compass_dev.agents WHERE id=$1", [agentId]);
    await pool.end();
  }
});
