/**
 * Opportunity detail "OST" tab follows the workspace thinking model, end to end.
 *
 * One Cycle -> Objective -> two Key Results, an Opportunity whose legacy Key Result pointer
 * (opportunities.linked_key_result_id) names the first Key Result, and one Solution. The typed link
 * tables are never written by raw SQL (typed-link-access guard); the legacy pointer is the supported
 * fallback parent in every preset, so each model has something to draw.
 *
 * `workspaces.thinking_model` is switched per test on the shared e2e workspace and always restored to NULL
 * (CLASSIC), because every other functional spec relies on CLASSIC copy and this suite is serialized.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/index";
import { E2E_SCHEMA, isolatedE2EConnectionString } from "../fixtures/isolated-database";

const S = `"${E2E_SCHEMA}"`;

test.describe.serial("Opportunity OST tab follows the thinking model", () => {
  test.setTimeout(120_000);
  const ids = { cycle: randomUUID(), objective: randomUUID(), kr: randomUUID(), kr2: randomUUID(), opp: randomUUID(), solution: randomUUID() };
  const tag = `OSTT ${Date.now()}`;
  const titles = {
    objective: `${tag} aim`,
    kr: `${tag} primary metric`,
    kr2: `${tag} second metric`,
    opp: `${tag} need`,
    solution: `${tag} fix`,
  };
  let pool: pg.Pool;
  let workspaceId: string;

  async function setModel(key: string | null) {
    await pool.query(`UPDATE ${S}.workspaces SET thinking_model = $1, thinking_model_labels = NULL WHERE id = $2`, [key, workspaceId]);
  }

  async function openOstTab(page: import("@playwright/test").Page, base: string) {
    await page.goto(`${base}/discovery/${ids.opp}?tab=ost`);
    const tab = page.getByRole("tab", { name: "OST" });
    await expect(tab).toBeVisible({ timeout: 30_000 });
    if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
    const panel = page.getByRole("tabpanel").filter({ has: page.getByText("Legend", { exact: true }) });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    return panel;
  }

  async function expectSolutionOpensPanel(page: import("@playwright/test").Page, panel: import("@playwright/test").Locator) {
    await panel.getByRole("button", { name: new RegExp(titles.solution) }).click();
    await expect(page).toHaveURL(new RegExp(`detail=solution(:|%3A)${ids.solution}`));
  }

  test.beforeAll(async () => {
    pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
    workspaceId = (
      await pool.query(
        `SELECT w.id FROM ${S}.workspaces w JOIN ${S}.organizations o ON o.id = w.organization_id
          WHERE w.slug = 'e2e-workspace' AND o.slug = 'e2e-test-org'`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO ${S}.okr_cycles (id, workspace_id, title, start_date, end_date) VALUES ($1, $2, $3, '2026-07-01', '2026-09-30')`,
      [ids.cycle, workspaceId, `${tag} cycle`],
    );
    await pool.query(`INSERT INTO ${S}.objectives (id, workspace_id, cycle_id, title) VALUES ($1, $2, $3, $4)`, [
      ids.objective,
      workspaceId,
      ids.cycle,
      titles.objective,
    ]);
    await pool.query(
      `INSERT INTO ${S}.key_results (id, objective_id, title, target, sort_order) VALUES ($1, $3, $4, 10, 0), ($2, $3, $5, 20, 1)`,
      [ids.kr, ids.kr2, ids.objective, titles.kr, titles.kr2],
    );
    await pool.query(
      `INSERT INTO ${S}.opportunities (id, workspace_id, title, linked_key_result_id) VALUES ($1, $2, $3, $4)`,
      [ids.opp, workspaceId, titles.opp, ids.kr],
    );
    await pool.query(`INSERT INTO ${S}.solutions (id, workspace_id, opportunity_id, title) VALUES ($1, $2, $3, $4)`, [
      ids.solution,
      workspaceId,
      ids.opp,
      titles.solution,
    ]);
  });

  test.afterEach(async () => {
    await setModel(null);
  });

  test.afterAll(async () => {
    if (!pool) return;
    try {
      await setModel(null);
      await pool.query(`DELETE FROM ${S}.solutions WHERE id = $1`, [ids.solution]);
      await pool.query(`DELETE FROM ${S}.opportunities WHERE id = $1`, [ids.opp]);
      await pool.query(`DELETE FROM ${S}.key_results WHERE id = ANY($1::uuid[])`, [[ids.kr, ids.kr2]]);
      await pool.query(`DELETE FROM ${S}.objectives WHERE id = $1`, [ids.objective]);
      await pool.query(`DELETE FROM ${S}.okr_cycles WHERE id = $1`, [ids.cycle]);
    } finally {
      await pool.end();
    }
  });

  test("CLASSIC: the Key Result is the root with its Objective as subtitle, no metric strip", async ({ page, base }) => {
    await setModel(null);
    const panel = await openOstTab(page, base);

    const parents = panel.getByTestId("ost-parents");
    await expect(parents.getByRole("button", { name: new RegExp(`${titles.objective}.*${titles.kr}`) })).toBeVisible();
    await expect(parents.getByText(titles.objective, { exact: true })).toBeVisible();
    await expect(parents.getByText(titles.kr, { exact: true })).toBeVisible();
    await expect(panel.getByTestId("ost-metrics")).toHaveCount(0);
    await expect(parents.locator(".border-dashed")).toHaveCount(0);
    await expect(panel.getByText("Outcome", { exact: true })).toBeVisible(); // legend root label
    await expect(panel.getByText(titles.opp, { exact: true })).toBeVisible();
    await expect(panel.getByText(titles.solution, { exact: true })).toBeVisible();
    await expectSolutionOpensPanel(page, panel);
  });

  test("OPPORTUNITY_FIRST_OKR: the Objective is the parent and the legacy Key Result is a dashed secondary node", async ({ page, base }) => {
    await setModel("OPPORTUNITY_FIRST_OKR");
    const panel = await openOstTab(page, base);

    const parents = panel.getByTestId("ost-parents");
    await expect(parents.getByText("Objective", { exact: true })).toBeVisible();
    await expect(parents.getByText(titles.objective, { exact: true })).toBeVisible();
    const dashed = parents.locator(".border-dashed");
    await expect(dashed).toHaveCount(1);
    await expect(dashed).toContainText(titles.kr);
    await expect(parents).not.toContainText(titles.kr2);
    await expect(panel.getByTestId("ost-metrics")).toHaveCount(0);
    await expect(panel.getByText(titles.opp, { exact: true })).toBeVisible();
    await expectSolutionOpensPanel(page, panel);
  });

  test("TORRES_OST: the Outcome is the root with a Success metrics strip and no legacy Key Result node", async ({ page, base }) => {
    await setModel("TORRES_OST");
    const panel = await openOstTab(page, base);

    const parents = panel.getByTestId("ost-parents");
    await expect(parents.getByText("Outcome", { exact: true })).toBeVisible();
    await expect(parents.getByText(titles.objective, { exact: true })).toBeVisible();
    const metrics = panel.getByTestId("ost-metrics");
    await expect(metrics).toContainText("Success metrics");
    await expect(metrics.getByRole("list", { name: "Success metrics" }).getByRole("listitem")).toHaveCount(2);
    await expect(metrics).toContainText(titles.kr);
    await expect(metrics).toContainText(titles.kr2);
    await expect(parents.locator(".border-dashed")).toHaveCount(0);
    expect(await parents.innerText()).not.toMatch(/key result/i);
    await expect(panel.getByText(titles.opp, { exact: true })).toBeVisible();
    await expectSolutionOpensPanel(page, panel);
  });
});
