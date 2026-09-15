/**
 * Linked-tasks-on-panels functional spec.
 *
 * The "Delivery tasks" sidebar affordance (add a task inline, link an
 * existing task, see it persist and navigate to it) used to be RoadmapItem
 * only (see roadmap-sidebar-delivery-tasks.spec.ts). It was generalized into
 * components/tasks/linked-tasks-section.tsx and is now rendered on the
 * Opportunity, Solution, Experiment, Objective, Key Result, Feedback Item,
 * and Doc panels too — a new user-facing journey on each of those surfaces.
 *
 * This spec covers the Opportunity panel end to end (add + link + persist +
 * navigate), modeled on opportunity-panel-solutions.spec.ts for the
 * panel-opening convention and on roadmap-sidebar-delivery-tasks.spec.ts for
 * the delivery-tasks interaction itself — same roles/labels, since
 * LinkedTasksSection renders identically across every panel it's mounted on.
 */
import pg from "pg";
import { test, expect } from "../fixtures/index";

const S = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";

/**
 * Seed one workspace-scoped task with no TaskLink at all, so it's a valid
 * "linkable" candidate for ANY entity's Link-existing-task dialog —
 * linkableTasks is a workspace-wide query (see lib/linked-tasks.ts), not
 * scoped to the entity being viewed, so this doesn't need the opportunity id
 * to exist yet.
 */
async function seedLinkableTask(): Promise<{ id: string; title: string }> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for functional seeding");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const stamp = Date.now();
  try {
    const { rows: [workspace] } = await pool.query<{ id: string }>(`
      SELECT w.id
      FROM "${S}".workspaces w
      JOIN "${S}".organizations o ON o.id = w.organization_id
      WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace'
      LIMIT 1
    `);
    if (!workspace) throw new Error("E2E workspace has not been seeded");

    const title = `E2E Linkable Candidate ${stamp}`;
    const { rows: [task] } = await pool.query<{ id: string }>(`
      INSERT INTO "${S}".tasks
        (id, workspace_id, title, status, priority, sort_order, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, 'IN_PROGRESS', 'HIGH', 50, NOW(), NOW())
      RETURNING id
    `, [workspace.id, title]);

    return { id: task.id, title };
  } finally {
    await pool.end();
  }
}

test.describe("Linked tasks — Opportunity panel", () => {
  test("add a task, link an existing task, both persist and navigate to the task", async ({
    page,
    base,
  }) => {
    const ts = Date.now();
    const oppTitle = `E2E LinkedTasks Opportunity ${ts}`;
    const addedTitle = `E2E Added From Opportunity ${ts}`;
    const linkable = await seedLinkableTask();

    // ── 1. Create an opportunity ──────────────────────────────────────────
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /Add opportunity/i }).first().click();
    await page.getByLabel("Title").fill(oppTitle);
    await page.getByRole("button", { name: "Create Opportunity" }).click();
    await expect(page.getByText(oppTitle)).toBeVisible({ timeout: 15_000 });

    // ── 2. Open its sidebar panel ─────────────────────────────────────────
    await page.getByRole("button", { name: oppTitle, exact: true }).click();
    const panel = page.locator('[data-slot="sheet-content"]');
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(/detail=opportunity/);

    // Empty state before anything is added — same copy as the roadmap sidebar.
    await expect(panel.getByText("No active delivery tasks are linked yet.")).toBeVisible();
    const list = panel.getByRole("list", { name: "Delivery tasks" });

    // ── 3. Add a task inline, with an assignee ────────────────────────────
    await panel.getByRole("button", { name: "Add task", exact: true }).click();
    await panel.getByLabel("Task title").fill(addedTitle);
    await panel.getByRole("combobox", { name: "Assignee" }).click();
    await page.getByRole("option", { name: "Dev User" }).waitFor({ state: "visible" });
    await page.keyboard.type("Dev User");
    await page.keyboard.press("Enter");
    await panel.getByRole("button", { name: "Add task", exact: true }).click();
    await expect(list.getByRole("link", { name: new RegExp(addedTitle) })).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText("No active delivery tasks are linked yet.")).not.toBeVisible();

    // ── 4. Link the pre-seeded existing task ──────────────────────────────
    await panel.getByRole("button", { name: "Link existing" }).click();
    await page.getByRole("dialog").getByRole("combobox").click();
    await page.getByRole("option", { name: linkable.title }).waitFor({ state: "visible" });
    await page.keyboard.type(linkable.title);
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").getByRole("button", { name: "Link task" }).click();
    await expect(list.getByRole("link", { name: new RegExp(linkable.title) })).toBeVisible({ timeout: 15_000 });

    // ── 5. Both survive a reload (server-fetched, not just optimistic UI) ─
    await page.reload();
    await page.waitForLoadState("networkidle");
    const reloadedPanel = page.locator('[data-slot="sheet-content"]');
    await expect(reloadedPanel.getByRole("link", { name: new RegExp(addedTitle) })).toBeVisible({ timeout: 15_000 });
    await expect(reloadedPanel.getByRole("link", { name: new RegExp(linkable.title) })).toBeVisible();

    // ── 6. The list row is a real navigation, not dead text ───────────────
    await reloadedPanel.getByRole("link", { name: new RegExp(addedTitle) }).click();
    await page.waitForURL(new RegExp(`/tasks/[0-9a-f-]{36}$`), { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: addedTitle })).toBeVisible({ timeout: 15_000 });
  });
});
