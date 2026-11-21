/**
 * Panel-level actions (Open full page, Request decision, Follow) live in the panel header as icon buttons, the same on
 * every panel, and are gone from the panel body. Opens each panel type through the real UI, checks where the controls
 * are, follows them, and saves a screenshot per panel to test-results/panel-header-actions/.
 *
 * Everything lives in a synthetic organization and workspace created and removed here; the shared e2e workspace is
 * untouched.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { test, expect } from "../fixtures/index";
import { E2E_SCHEMA, isolatedE2EConnectionString } from "../fixtures/isolated-database";

const S = `"${E2E_SCHEMA}"`;
const SHOTS = "test-results/panel-header-actions";

test.describe.serial("Panel header actions", () => {
  test.setTimeout(180_000);
  const suffix = randomUUID().slice(0, 8);
  const orgSlug = `phdr-org-${suffix}`;
  const workspaceSlug = `phdr-ws-${suffix}`;
  const base = `/${orgSlug}/${workspaceSlug}`;
  const ids = { org: randomUUID(), workspace: randomUUID(), cycle: randomUUID(), objective: randomUUID(), kr: randomUUID(), opp: randomUUID(), solution: randomUUID(), feedback: randomUUID(), experiment: randomUUID(), roadmap: randomUUID() };
  const tag = `PHA ${Date.now()}`;
  let pool: pg.Pool;

  test.beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
    const userId = (await pool.query(`SELECT id FROM ${S}.users WHERE email = 'dev@localhost.dev'`)).rows[0].id;
    await pool.query(`INSERT INTO ${S}.organizations (id, slug, name) VALUES ($1, $2, $3)`, [ids.org, orgSlug, `${tag} org`]);
    await pool.query(`INSERT INTO ${S}.organization_members (organization_id, user_id, role) VALUES ($1, $2, 'MEMBER')`, [ids.org, userId]);
    await pool.query(`INSERT INTO ${S}.workspaces (id, organization_id, slug, name) VALUES ($1, $2, $3, $4)`, [ids.workspace, ids.org, workspaceSlug, `${tag} workspace`]);
    await pool.query(`INSERT INTO ${S}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'ADMIN')`, [ids.workspace, userId]);
    await pool.query(`INSERT INTO ${S}.okr_cycles (id, workspace_id, title, start_date, end_date, status) VALUES ($1, $2, $3, '2026-07-01', '2026-09-30', 'ACTIVE')`, [ids.cycle, ids.workspace, `${tag} cycle`]);
    await pool.query(`INSERT INTO ${S}.objectives (id, workspace_id, cycle_id, title) VALUES ($1, $2, $3, $4)`, [ids.objective, ids.workspace, ids.cycle, `${tag} objective`]);
    await pool.query(`INSERT INTO ${S}.key_results (id, objective_id, title, target, current) VALUES ($1, $2, $3, 10, 4)`, [ids.kr, ids.objective, `${tag} key result`]);
    await pool.query(`INSERT INTO ${S}.opportunities (id, workspace_id, title) VALUES ($1, $2, $3)`, [ids.opp, ids.workspace, `${tag} opportunity`]);
    await pool.query(`INSERT INTO ${S}.solutions (id, workspace_id, opportunity_id, title) VALUES ($1, $2, $3, $4)`, [ids.solution, ids.workspace, ids.opp, `${tag} solution`]);
    await pool.query(`INSERT INTO ${S}.feedback (id, workspace_id, title, status) VALUES ($1, $2, $3, 'OPEN')`, [ids.feedback, ids.workspace, `${tag} feedback`]);
    await pool.query(
      `INSERT INTO ${S}.experiments (id, workspace_id, title, hypothesis, method, kill_condition, status, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, 'We believe this works', 'A/B test', 'Stop if it does not', 'PLANNED', 0, NOW(), NOW())`,
      [ids.experiment, ids.workspace, `${tag} experiment`],
    );
    await pool.query(
      `INSERT INTO ${S}.roadmap_items (id, workspace_id, title, horizon, status, sort_order, is_private, created_at, updated_at)
       VALUES ($1, $2, $3, 'NOW', 'ACTIVE', 0, false, NOW(), NOW())`,
      [ids.roadmap, ids.workspace, `${tag} roadmap item`],
    );
  });

  test.afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DELETE FROM ${S}.roadmap_items WHERE workspace_id = $1`, [ids.workspace]);
      await pool.query(`DELETE FROM ${S}.experiments WHERE workspace_id = $1`, [ids.workspace]);
      await pool.query(`DELETE FROM ${S}.feedback WHERE workspace_id = $1`, [ids.workspace]);
      await pool.query(`DELETE FROM ${S}.solutions WHERE workspace_id = $1`, [ids.workspace]);
      await pool.query(`DELETE FROM ${S}.opportunities WHERE workspace_id = $1`, [ids.workspace]);
      await pool.query(`DELETE FROM ${S}.key_results WHERE objective_id = $1`, [ids.objective]);
      await pool.query(`DELETE FROM ${S}.objectives WHERE workspace_id = $1`, [ids.workspace]);
      await pool.query(`DELETE FROM ${S}.okr_cycles WHERE id = $1`, [ids.cycle]);
      await pool.query(`DELETE FROM ${S}.workspace_members WHERE workspace_id = $1`, [ids.workspace]);
      await pool.query(`DELETE FROM ${S}.workspaces WHERE id = $1`, [ids.workspace]);
      await pool.query(`DELETE FROM ${S}.organization_members WHERE organization_id = $1`, [ids.org]);
      await pool.query(`DELETE FROM ${S}.organizations WHERE id = $1`, [ids.org]);
    } finally {
      await pool.end();
    }
  });

  // [panel type, id key, expected full-page path, has Request decision]
  const cases: Array<[string, keyof typeof ids, RegExp, boolean]> = [
    ["keyResult", "kr", /\/okrs\//, false],
    ["objective", "objective", /\/okrs\//, false],
    ["feedback", "feedback", /\/feedback$/, true],
    ["solution", "solution", /\/discovery\/[0-9a-f-]{36}$/, true],
    ["experiment", "experiment", /\/experiments\/[0-9a-f-]{36}$/, true],
    ["opportunity", "opp", /\/discovery\/[0-9a-f-]{36}$/, true],
    ["roadmapItem", "roadmap", /\/roadmap\/[0-9a-f-]{36}$/, true],
  ];

  for (const [type, key, fullPage, hasDecision] of cases) {
    test(`${type} panel: actions are icons in the header, not in the body`, async ({ page }) => {
      await page.goto(`${base}/discovery?detail=${type}:${ids[key]}`);
      await page.waitForLoadState("networkidle");
      const panel = page.locator('[data-slot="sheet-content"]');
      const header = panel.locator('[data-slot="sheet-header"]');
      await expect(header).toBeVisible({ timeout: 30_000 });

      const openFull = header.getByRole("link", { name: "Open full page" });
      await expect(openFull).toBeVisible({ timeout: 30_000 });
      await expect(openFull).toHaveAttribute("href", fullPage);
      expect(((await openFull.textContent()) ?? "").trim()).toBe(""); // icon only

      const decision = header.getByRole("link", { name: "Request decision" });
      if (hasDecision) {
        await expect(decision).toBeVisible();
        await expect(decision).toHaveAttribute("href", new RegExp(`/decisions/new\\?subjectType=`));
        // Order is fixed: Request decision, then Open full page.
        const [d, f] = await Promise.all([decision.boundingBox(), openFull.boundingBox()]);
        expect(d!.x).toBeLessThan(f!.x);
      } else {
        await expect(decision).toHaveCount(0);
      }

      // Nothing left in the body: no text link row, no big button.
      const body = panel.locator('[data-slot="sheet-header"] ~ *');
      await expect(body.getByText("Open full page")).toHaveCount(0);
      await expect(body.getByText("Request decision")).toHaveCount(0);
      await expect(body.getByRole("link", { name: /Open full page|Request decision/ })).toHaveCount(0);

      await page.screenshot({ path: `${SHOTS}/${type}.png` });
    });
  }

  test("desktop 1280x800: the header holds the actions without crowding the title", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/discovery?detail=feedback:${ids.feedback}`);
    await page.waitForLoadState("networkidle");
    const header = page.locator('[data-slot="sheet-content"] [data-slot="sheet-header"]');
    await expect(header.getByRole("link", { name: "Request decision" })).toBeVisible({ timeout: 30_000 });
    await expect(header.getByRole("button", { name: "Close panel" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/desktop-1280x800-feedback.png` });
  });

  for (const [type, key] of [["feedback", "feedback"], ["keyResult", "kr"], ["solution", "solution"], ["opportunity", "opp"]] as const) {
    test(`mobile 390x844: ${type} header actions fit on screen and are reachable`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base}/discovery?detail=${type}:${ids[key]}`);
      await page.waitForLoadState("networkidle");
      const header = page.locator('[data-slot="sheet-content"] [data-slot="sheet-header"]');
      await expect(header).toBeVisible({ timeout: 30_000 });
      await expect(header.getByRole("link", { name: "Open full page" })).toBeVisible({ timeout: 30_000 });

      // Every header control is fully on screen and a usable tap target (the pin toggle is intentionally hidden below lg).
      const controls = header.locator("a, button").filter({ visible: true });
      const count = await controls.count();
      expect(count).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < count; i++) {
        const box = await controls.nth(i).boundingBox();
        expect(box, `control ${i}`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
        expect(box!.width).toBeGreaterThanOrEqual(28);
        expect(box!.height).toBeGreaterThanOrEqual(28);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.screenshot({ path: `${SHOTS}/mobile-390x844-${type}.png` });
    });
  }

  test("the header actions work: Open full page navigates, Request decision prefills the subject", async ({ page }) => {
    await page.goto(`${base}/discovery?detail=feedback:${ids.feedback}`);
    await page.waitForLoadState("networkidle");
    const header = page.locator('[data-slot="sheet-content"] [data-slot="sheet-header"]');
    await header.getByRole("link", { name: "Request decision" }).click();
    await page.waitForURL(/\/decisions\/new\?/, { timeout: 30_000 });
    const url = new URL(page.url());
    expect(url.searchParams.get("subjectType")).toBe("FEEDBACK");
    expect(url.searchParams.get("subjectId")).toBe(ids.feedback);
    expect(url.searchParams.get("subjectTitle")).toBe(`${tag} feedback`);

    await page.goto(`${base}/discovery?detail=keyResult:${ids.kr}`);
    await page.waitForLoadState("networkidle");
    await page.locator('[data-slot="sheet-content"] [data-slot="sheet-header"]').getByRole("link", { name: "Open full page" }).click();
    await page.waitForURL(/\/okrs\//, { timeout: 30_000 });
  });

  test("switching panels replaces the header actions (no stale icons from the previous panel)", async ({ page }) => {
    await page.goto(`${base}/discovery?detail=feedback:${ids.feedback}`);
    await page.waitForLoadState("networkidle");
    const header = page.locator('[data-slot="sheet-content"] [data-slot="sheet-header"]');
    await expect(header.getByRole("link", { name: "Request decision" })).toBeVisible({ timeout: 30_000 });

    await page.goto(`${base}/discovery?detail=keyResult:${ids.kr}`);
    await page.waitForLoadState("networkidle");
    await expect(header.getByRole("link", { name: "Open full page" })).toBeVisible({ timeout: 30_000 });
    await expect(header.getByRole("link", { name: "Request decision" })).toHaveCount(0);
  });
});
