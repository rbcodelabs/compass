import pg from "pg";
import { test, expect } from "../fixtures/index";
import { assertIsolatedE2EDatabase, isolatedE2EConnectionString } from "../fixtures/isolated-database";

const nativeId = "3eaf938a-782c-4073-a452-070d54156896";
const nativeBase = "/e2e-test-org/native-dogfood";
const start = new Date().toISOString().slice(0, 8) + "01";
const end = new Date().toISOString().slice(0, 8) + "28";

test.describe("Native timeline limited rollout", () => {
  test.beforeAll(async () => {
    // Mirror only the cohort identity in disposable, sentinel-protected local
    // Postgres. Never relax the production gate for tests. Global teardown
    // owns every workspace beneath this run's e2e-test-org.
    await assertIsolatedE2EDatabase();
    const pool = new pg.Client({ connectionString: isolatedE2EConnectionString() });
    await pool.connect();
    try {
      await pool.query("BEGIN");
      const existing = await pool.query(`SELECT w.id FROM compass_dev.workspaces w
        JOIN compass_dev.organizations o ON o.id = w.organization_id
        WHERE w.id = $1 AND w.slug = 'native-dogfood' AND o.slug = 'e2e-test-org'`, [nativeId]);
      if (existing.rowCount) {
        await pool.query("COMMIT");
        return; // A failed test restarts its worker, not the owned fixture.
      }
      await pool.query(`INSERT INTO compass_dev.workspaces
        (id, organization_id, slug, name, roadmap_public, feedback_enabled, created_at, updated_at)
        SELECT $1, id, 'native-dogfood', 'Native timeline dogfood', false, false, NOW(), NOW()
        FROM compass_dev.organizations WHERE slug = 'e2e-test-org'`, [nativeId]);
      await pool.query(`INSERT INTO compass_dev.workspace_members (id, workspace_id, user_id, role, created_at)
        SELECT gen_random_uuid(), $1, id, 'ADMIN', NOW() FROM compass_dev.users WHERE email = 'dev@localhost.dev'`, [nativeId]);
      for (const name of ["Alpha", "Beta"]) {
        const { rows: [squad] } = await pool.query(`INSERT INTO compass_dev.squads (id, workspace_id, name, color, created_at)
          VALUES (gen_random_uuid(), $1, $2, '#6366f1', NOW()) RETURNING id`, [nativeId, name]);
        await pool.query(`INSERT INTO compass_dev.roadmap_items
          (id, workspace_id, squad_id, title, horizon, status, sort_order, start_date, end_date, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, $2, $3, 'NEXT', 'ACTIVE', 0, $4, $5, NOW(), NOW())`, [nativeId, squad.id, `${name} delivery`, start, end]);
      }
      await pool.query(`INSERT INTO compass_dev.feedback (id, workspace_id, title, type, status, vote_count, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, 'Native backlog bug', 'BUG', 'OPEN', 0, NOW(), NOW())`, [nativeId]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    } finally { await pool.end(); }
  });

  test("native scheduling persists, classic fallback and board remain available", async ({ page }) => {
    await page.goto(`${nativeBase}/roadmap`);
    await page.getByRole("button", { name: "Add item", exact: true }).nth(1).click();
    await page.getByLabel("Title", { exact: true }).fill("Native rollout scheduling");
    await page.getByRole("button", { name: "Add Item", exact: true }).click();
    await expect(page.getByText("Native rollout scheduling", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await expect(page.getByRole("link", { name: "Use classic timeline" })).toBeVisible();
    await page.getByRole("button", { name: "Edit dates for Native rollout scheduling", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Start", { exact: true }).fill(start);
    await dialog.getByLabel("End", { exact: true }).fill(end);
    await dialog.getByRole("button", { name: "Save schedule", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Edit dates for Native rollout scheduling", exact: true }).click();
    await expect(dialog.getByLabel("Start", { exact: true })).toHaveValue(start);
    await expect(dialog.getByLabel("End", { exact: true })).toHaveValue(end);
    await page.keyboard.press("Escape");
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: `public/screenshots/docs/native-timeline-${viewport.width}.png`, fullPage: true, style: "nextjs-portal { display: none }" });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("link", { name: "Use classic timeline" }).click();
    await expect(page).toHaveURL(/timelineEngine=classic/);
    await expect(page.getByRole("tab", { name: "Year", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add item", exact: true }).first()).toBeVisible();
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Year", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/timelineEngine=classic/);
    await page.getByRole("link", { name: "Use native timeline" }).click();
    await expect(page.getByRole("link", { name: "Use classic timeline" })).toBeVisible();
  });

  test("squad filter drops old native rows and survives renderer fallback", async ({ page }) => {
    await page.goto(`${nativeBase}/roadmap?view=timeline`);
    await expect(page.getByRole("button", { name: /Open details for Alpha delivery/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Open details for Beta delivery/ })).toBeVisible();
    await page.getByRole("button", { name: /Filters/ }).click();
    await page.getByRole("menuitemradio", { name: "Alpha", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /Open details for Alpha delivery/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Open details for Beta delivery/ })).toHaveCount(0);
    const squad = new URL(page.url()).searchParams.get("squad");
    await page.getByRole("link", { name: "Use classic timeline" }).click();
    expect(new URL(page.url()).searchParams.get("squad")).toBe(squad);
    await page.getByRole("link", { name: "Use native timeline" }).click();
    expect(new URL(page.url()).searchParams.get("squad")).toBe(squad);
    await expect(page.getByRole("button", { name: /Open details for Beta delivery/ })).toHaveCount(0);
  });

  test("query cannot opt another workspace into native", async ({ page, base }) => {
    await page.goto(`${base}/roadmap?view=timeline&timelineEngine=native`);
    await expect(page.getByRole("tab", { name: "Year", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Use classic timeline" })).toHaveCount(0);
  });

  test("native backlog quick-add persists on the roadmap", async ({ page }) => {
    await page.goto(`${nativeBase}/roadmap?view=timeline`);
    const backlog = page.locator('[data-testid^="unscheduled-item-"]').filter({ hasText: "Native backlog bug" });
    await backlog.getByRole("button", { name: "Card actions" }).click();
    await page.getByRole("menuitem", { name: "Add to Next", exact: true }).click();
    await expect(backlog).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-testid^="unscheduled-item-"]').filter({ hasText: "Native backlog bug" })).toHaveCount(0);
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    await expect(page.getByText("Native backlog bug", { exact: true })).toBeVisible();
  });
});
