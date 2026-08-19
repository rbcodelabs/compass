/**
 * Roadmap sidebar delivery-tasks functional spec.
 *
 * Seed the state matrix directly into the same local Postgres used by the
 * functional harness, then exercise the user-facing sidebar mutations. Direct
 * seeding keeps this focused on the sidebar rather than repeating task-board
 * drag/link coverage from roadmap-delivery-status.spec.ts.
 */
import pg from "pg";
import { test, expect } from "../fixtures/index";

const S = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";

type SeededJourney = {
  roadmapId: string;
  roadmapTitle: string;
  linked: Array<{ id: string; title: string; status: string }>;
  existingTaskId: string;
  existingTaskTitle: string;
};

async function seedJourney(): Promise<SeededJourney> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for functional seeding");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const stamp = Date.now();
  try {
    const { rows: [workspace] } = await pool.query<{ id: string; user_id: string }>(`
      SELECT w.id, wm.user_id
      FROM "${S}".workspaces w
      JOIN "${S}".organizations o ON o.id = w.organization_id
      JOIN "${S}".workspace_members wm ON wm.workspace_id = w.id
      WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace'
      LIMIT 1
    `);
    if (!workspace) throw new Error("E2E workspace has not been seeded");

    const roadmapTitle = `E2E Sidebar Delivery ${stamp}`;
    const { rows: [roadmap] } = await pool.query<{ id: string }>(`
      INSERT INTO "${S}".roadmap_items
        (id, workspace_id, title, horizon, status, sort_order, is_private, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, 'NOW', 'ACTIVE', 0, false, NOW(), NOW())
      RETURNING id
    `, [workspace.id, roadmapTitle]);

    const cases = [
      { status: "TODO", label: "Not Started", priority: "LOW" },
      { status: "DONE", label: "Complete", priority: "MEDIUM" },
      { status: "IN_PROGRESS", label: "In Development", priority: "HIGH" },
      { status: "IN_REVIEW", label: "In Review", priority: "URGENT" },
      { status: "BLOCKED", label: "Blocked", priority: "URGENT" },
      { status: "CANCELLED", label: "Cancelled", priority: "LOW" },
    ];
    const linked: SeededJourney["linked"] = [];
    for (const [index, item] of cases.entries()) {
      const title = `E2E ${item.label} ${stamp}`;
      const { rows: [task] } = await pool.query<{ id: string }>(`
        INSERT INTO "${S}".tasks
          (id, workspace_id, title, status, priority, assignee_user_id, sort_order, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW(), NOW())
        RETURNING id
      `, [workspace.id, title, item.status, item.priority, workspace.user_id, index]);
      await pool.query(`
        INSERT INTO "${S}".task_links
          (id, task_id, linked_type, linked_id, created_at)
        VALUES (gen_random_uuid(), $1, 'ROADMAP_ITEM', $2, NOW())
      `, [task.id, roadmap.id]);
      linked.push({ id: task.id, title, status: item.status });
    }

    const existingTaskTitle = `E2E Existing Link Candidate ${stamp}`;
    const { rows: [existingTask] } = await pool.query<{ id: string }>(`
      INSERT INTO "${S}".tasks
        (id, workspace_id, title, status, priority, sort_order, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, 'IN_PROGRESS', 'HIGH', 50, NOW(), NOW())
      RETURNING id
    `, [workspace.id, existingTaskTitle]);

    return { roadmapId: roadmap.id, roadmapTitle, linked, existingTaskId: existingTask.id, existingTaskTitle };
  } finally {
    await pool.end();
  }
}

test.describe("Roadmap sidebar delivery tasks", () => {
  test("shows ordered task evidence and supports add, link, persistence, and navigation", async ({ page, base }) => {
    const seeded = await seedJourney();
    const addedTitle = `E2E Added From Sidebar ${Date.now()}`;

    await page.goto(`${base}/roadmap`);
    await page.waitForLoadState("networkidle");
    const card = page.locator('[data-slot="card"]').filter({ hasText: seeded.roadmapTitle });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole("button", { name: seeded.roadmapTitle }).click();

    const panel = page.locator('[data-slot="sheet-content"]');
    await expect(panel).toBeVisible();
    const list = panel.getByRole("list", { name: "Delivery tasks" });
    const rows = list.getByRole("listitem");
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toContainText("Blocked");
    await expect(rows.nth(1)).toContainText("In Review");
    await expect(rows.nth(2)).toContainText("In Development");
    await expect(rows.nth(3)).toContainText("Complete");
    await expect(rows.nth(4)).toContainText("Not Started");
    await expect(panel.getByText(seeded.linked.find((task) => task.status === "CANCELLED")!.title)).toHaveCount(0);

    const blockedTitle = seeded.linked.find((task) => task.status === "BLOCKED")!.title;
    const blockedRow = rows.nth(0);
    await expect(blockedRow).toContainText(blockedTitle);
    await expect(blockedRow).toContainText(/urgent/i);
    await expect(blockedRow).toContainText("Dev User");

    await panel.getByRole("button", { name: "Add task", exact: true }).click();
    await panel.getByLabel("Task title").fill(addedTitle);
    await panel.getByRole("combobox", { name: "Assignee" }).click();
    await page.getByRole("option", { name: "Dev User" }).waitFor({ state: "visible" });
    await page.keyboard.type("Dev User");
    await page.keyboard.press("Enter");
    await panel.getByRole("button", { name: "Add task", exact: true }).click();
    await expect(list.getByRole("link", { name: new RegExp(addedTitle) })).toBeVisible({ timeout: 15_000 });
    await expect(card.getByLabel("Delivery status: Blocked")).toBeVisible();

    await panel.getByRole("button", { name: "Link existing" }).click();
    await page.getByRole("dialog").getByRole("combobox").click();
    await page.getByRole("option", { name: seeded.existingTaskTitle }).waitFor({ state: "visible" });
    await page.keyboard.type(seeded.existingTaskTitle);
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").getByRole("button", { name: "Link task" }).click();
    await expect(list.getByRole("link", { name: new RegExp(seeded.existingTaskTitle) })).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await page.waitForLoadState("networkidle");
    const reloadedPanel = page.locator('[data-slot="sheet-content"]');
    await expect(reloadedPanel.getByRole("link", { name: new RegExp(addedTitle) })).toBeVisible({ timeout: 15_000 });
    await expect(reloadedPanel.getByRole("link", { name: new RegExp(seeded.existingTaskTitle) })).toBeVisible();

    await reloadedPanel.getByRole("link", { name: new RegExp(addedTitle) }).click();
    await page.waitForURL(new RegExp(`/tasks/[0-9a-f-]{36}$`), { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: addedTitle })).toBeVisible({ timeout: 15_000 });
  });
});
