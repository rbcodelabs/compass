/**
 * Thinking model Phase 3C, end to end: the workspace tree under TORRES_OST, the Outcomes
 * index, and the Opportunity <-> Objective picker, plus CLASSIC seeing none of it.
 *
 * Seeds `workspaces.thinking_model` with raw SQL on the shared e2e workspace and always
 * restores NULL (CLASSIC) afterwards, because every other functional spec relies on
 * CLASSIC copy and this suite is serialized over one workspace. The synthetic cycle,
 * objective, opportunities and solution are inserted by id with raw SQL and removed by id.
 * The link edge is created through the picker (lib/typed-links.ts), never by raw SQL; raw SQL only
 * counts and deletes link rows, link rows first on cleanup (no foreign keys reach them).
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/index";
import { E2E_SCHEMA, isolatedE2EConnectionString } from "../fixtures/isolated-database";

const S = `"${E2E_SCHEMA}"`;

test.describe.serial("Thinking model tree and picker", () => {
  test.setTimeout(180_000);
  const ids = {
    cycle: randomUUID(),
    objective: randomUUID(),
    kr: randomUUID(),
    linkedOpp: randomUUID(),
    poolOpp: randomUUID(),
    solution: randomUUID(),
  };
  const tag = `TMT ${Date.now()}`;
  let pool: pg.Pool;
  let workspaceId: string;

  async function setModel(key: string | null) {
    await pool.query(
      `UPDATE ${S}.workspaces SET thinking_model = $1, thinking_model_labels = NULL WHERE id = $2`,
      [key, workspaceId],
    );
  }

  /** Count only: raw SQL may read-count and delete link rows here, never insert or update them. */
  async function countLinks(opportunityId: string, extra = "", extraParams: unknown[] = []) {
    const result = await pool.query(`SELECT count(*)::int AS n FROM ${S}.opportunity_objective_links WHERE opportunity_id = $1 AND objective_id = $2 ${extra}`, [opportunityId, ids.objective, ...extraParams]);
    return result.rows[0].n as number;
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
    await pool.query(
      `INSERT INTO ${S}.objectives (id, workspace_id, cycle_id, title) VALUES ($1, $2, $3, $4)`,
      [ids.objective, workspaceId, ids.cycle, `${tag} aim`],
    );
    await pool.query(
      `INSERT INTO ${S}.key_results (id, objective_id, title, target) VALUES ($1, $2, $3, 10)`,
      [ids.kr, ids.objective, `${tag} metric`],
    );
    await pool.query(
      `INSERT INTO ${S}.opportunities (id, workspace_id, title) VALUES ($1, $3, $4), ($2, $3, $5)`,
      [ids.linkedOpp, ids.poolOpp, workspaceId, `${tag} linked need`, `${tag} pool need`],
    );
    await pool.query(
      `INSERT INTO ${S}.solutions (id, workspace_id, opportunity_id, title) VALUES ($1, $2, $3, $4)`,
      [ids.solution, workspaceId, ids.linkedOpp, `${tag} solution`],
    );
    // No link row is inserted here: raw SQL may not write the link tables (typed-link-access guard).
    // The first test creates the edge through the picker, which goes through lib/typed-links.ts.
  });

  test.afterEach(async () => {
    await setModel(null);
  });

  test.afterAll(async () => {
    if (!pool) return;
    try {
      await setModel(null);
      await pool.query(`DELETE FROM ${S}.solution_key_result_links WHERE workspace_id = $1 AND key_result_id = $2`, [workspaceId, ids.kr]);
      await pool.query(`DELETE FROM ${S}.opportunity_objective_links WHERE workspace_id = $1 AND objective_id = $2`, [workspaceId, ids.objective]);
      await pool.query(`DELETE FROM ${S}.solutions WHERE id = $1`, [ids.solution]);
      await pool.query(`DELETE FROM ${S}.opportunities WHERE id = ANY($1::uuid[])`, [[ids.linkedOpp, ids.poolOpp]]);
      await pool.query(`DELETE FROM ${S}.key_results WHERE id = $1`, [ids.kr]);
      await pool.query(`DELETE FROM ${S}.objectives WHERE id = $1`, [ids.objective]);
      await pool.query(`DELETE FROM ${S}.okr_cycles WHERE id = $1`, [ids.cycle]);
    } finally {
      await pool.end();
    }
  });

  test("TORRES_OST: the picker links an opportunity to an outcome (this edge feeds the tree tests below)", async ({ page, base }) => {
    await setModel("TORRES_OST");
    await page.goto(`${base}/discovery/${ids.linkedOpp}`);
    await page.waitForLoadState("networkidle");
    const picker = page.getByTestId("opportunity-objective-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    expect(await countLinks(ids.linkedOpp)).toBe(0);
    await picker.getByRole("button", { name: "Choose outcomes" }).click();
    await page.getByRole("menuitemcheckbox", { name: new RegExp(`${tag} aim`) }).click();
    await expect(picker.getByRole("listitem")).toContainText(`${tag} aim`, { timeout: 15_000 });
    expect(await countLinks(ids.linkedOpp, "AND workspace_id = $3 AND origin = 'DIRECT' AND source = 'UI'", [workspaceId])).toBe(1);
  });

  test("TORRES_OST: the tree shows the linked need under its outcome and the other in the pool, in Outcome words", async ({ page, base }) => {
    await setModel("TORRES_OST");
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("link", { name: "Outcome tree" }).click();
    await expect(page).toHaveURL(/\/discovery\/tree$/);

    const tree = page.getByTestId("outcome-tree");
    await expect(tree).toBeVisible({ timeout: 30_000 });
    const root = page.getByTestId(`outcome-root-${ids.objective}`);
    await expect(root).toContainText(`${tag} aim`);
    await expect(page.getByTestId(`outcome-cycle-${ids.objective}`)).toContainText(`${tag} cycle`);
    await expect(root.getByTestId(`outcome-opportunity-${ids.objective}-${ids.linkedOpp}`)).toContainText(`${tag} linked need`);
    await expect(root.getByTestId(`outcome-solution-${ids.solution}`)).toBeVisible();
    await expect(page.getByTestId(`outcome-pool-opportunity-${ids.poolOpp}`)).toContainText(`${tag} pool need`);
    await expect(page.getByTestId("outcome-pool")).toContainText("not linked to outcomes");
    // Our own subtree uses the preset's words.
    await expect(root.getByText("Success metrics", { exact: true })).toBeVisible();
    expect(await root.innerText()).not.toMatch(/objective|key result/i);
  });

  test("TORRES_OST: the Outcomes index is on the nav page without choosing a cycle", async ({ page, base }) => {
    await setModel("TORRES_OST");
    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");
    const row = page.getByTestId(`outcomes-index-row-${ids.objective}`);
    await expect(row).toContainText(`${tag} aim`);
    await expect(row).toContainText("1 linked opportunity");
    await expect(page.getByTestId(`outcomes-index-cycle-${ids.objective}`)).toContainText(`${tag} cycle`);
  });

  test("TORRES_OST: the picker links the pool need to the outcome and the tree follows", async ({ page, base }) => {
    await setModel("TORRES_OST");
    await page.goto(`${base}/discovery/${ids.poolOpp}`);
    await page.waitForLoadState("networkidle");

    const picker = page.getByTestId("opportunity-objective-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await expect(picker).toContainText("Outcomes");
    await expect(picker).toContainText("No outcomes linked.");

    await picker.getByRole("button", { name: "Choose outcomes" }).click();
    await page.getByRole("menuitemcheckbox", { name: new RegExp(`${tag} aim`) }).click();
    await expect(picker.getByRole("listitem")).toContainText(`${tag} aim`, { timeout: 15_000 });

    // The write is a typed link stamped with the opportunity's workspace.
    expect(await countLinks(ids.poolOpp, "AND workspace_id = $3 AND origin = 'DIRECT' AND source = 'UI'", [workspaceId])).toBe(1);

    await page.goto(`${base}/discovery/tree`);
    await expect(
      page.getByTestId(`outcome-root-${ids.objective}`).getByTestId(`outcome-opportunity-${ids.objective}-${ids.poolOpp}`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`outcome-pool-opportunity-${ids.poolOpp}`)).toHaveCount(0);

    // Unlink through the same picker.
    await page.goto(`${base}/discovery/${ids.poolOpp}`);
    const again = page.getByTestId("opportunity-objective-picker");
    await again.getByRole("button", { name: "Choose outcomes" }).click();
    await page.getByRole("menuitemcheckbox", { name: new RegExp(`${tag} aim`) }).click();
    await expect(again).toContainText("No outcomes linked.", { timeout: 15_000 });
    expect(await countLinks(ids.poolOpp)).toBe(0);
  });

  test("CLASSIC (NULL): no tree link, no tree route, no picker, no index", async ({ page, base }) => {
    await setModel(null);
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: /tree$/i })).toHaveCount(0);

    const response = await page.goto(`${base}/discovery/tree`);
    expect(response?.status()).toBe(404);

    await page.goto(`${base}/discovery/${ids.linkedOpp}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: `${tag} linked need` })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("opportunity-objective-picker")).toHaveCount(0);

    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("outcomes-index")).toHaveCount(0);
  });

  test("OPPORTUNITY_FIRST_OKR: the picker says Objectives and the tree starts from the pool", async ({ page, base }) => {
    await setModel("OPPORTUNITY_FIRST_OKR");
    await page.goto(`${base}/discovery/${ids.poolOpp}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("opportunity-objective-picker")).toContainText("Objectives", { timeout: 30_000 });

    await page.goto(`${base}/discovery/tree`);
    const tree = page.getByTestId("outcome-tree");
    await expect(tree).toHaveAttribute("data-shape", "objective-rooted-pool", { timeout: 30_000 });
    await expect(tree.locator("> *").first()).toHaveAttribute("data-testid", "outcome-pool");
    await expect(page.getByTestId(`outcome-metrics-${ids.objective}`)).toContainText(`${tag} metric`);
  });
});
