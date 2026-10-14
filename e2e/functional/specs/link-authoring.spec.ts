/**
 * Thinking model Phase 4B, end to end: the Solution <-> Key Result picker, the Key Result panel's
 * "Linked solutions", the Objective multi-select in the opportunity composer,
 * under TORRES_OST, plus CLASSIC seeing none of the new UI.
 *
 * Everything lives in a SYNTHETIC organization and workspace created here by id and removed by id, so the
 * shared e2e workspace (whose NULL / CLASSIC state every other spec relies on) is never touched. The seeded
 * e2e user is made a member of the synthetic workspace. Raw SQL inserts only the ordinary rows (cycle, objective,
 * key result, opportunities, solution); it NEVER inserts into the link tables (the typed-link-access guard): every
 * link edge is created through the UI (typed-link module) or the legacy key result combobox, and raw SQL only
 * counts and deletes link rows, link rows first on cleanup (no foreign keys reach them).
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/index";
import { E2E_SCHEMA, isolatedE2EConnectionString } from "../fixtures/isolated-database";

const S = `"${E2E_SCHEMA}"`;

test.describe.serial("Link authoring (Phase 4B)", () => {
  test.setTimeout(180_000);
  const suffix = randomUUID().slice(0, 8);
  const orgSlug = `link-ui-org-${suffix}`;
  const workspaceSlug = `link-ui-ws-${suffix}`;
  const base = `/${orgSlug}/${workspaceSlug}`;
  const ids = {
    org: randomUUID(),
    workspace: randomUUID(),
    cycle: randomUUID(),
    objective: randomUUID(),
    kr: randomUUID(),
    legacyOpp: randomUUID(),
    solution: randomUUID(),
  };
  const tag = `LNK ${Date.now()}`;
  const composedTitle = `${tag} composed need`;
  let pool: pg.Pool;
  let composedOpp = "";

  const setModel = (key: string | null) =>
    pool.query(`UPDATE ${S}.workspaces SET thinking_model = $1, thinking_model_labels = NULL WHERE id = $2`, [key, ids.workspace]);

  /** Count only: raw SQL may read-count and delete link rows here, never insert or update them. */
  async function count(table: "solution_key_result_links" | "opportunity_objective_links", where: string, params: unknown[]) {
    const result = await pool.query(`SELECT count(*)::int AS n FROM ${S}.${table} WHERE workspace_id = $1 AND ${where}`, [ids.workspace, ...params]);
    return result.rows[0].n as number;
  }

  test.beforeAll(async () => {
    pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
    const userId = (await pool.query(`SELECT id FROM ${S}.users WHERE email = 'dev@localhost.dev'`)).rows[0].id;
    await pool.query(`INSERT INTO ${S}.organizations (id, slug, name) VALUES ($1, $2, $3)`, [ids.org, orgSlug, `${tag} org`]);
    await pool.query(`INSERT INTO ${S}.organization_members (organization_id, user_id, role) VALUES ($1, $2, 'MEMBER')`, [ids.org, userId]);
    await pool.query(`INSERT INTO ${S}.workspaces (id, organization_id, slug, name, thinking_model) VALUES ($1, $2, $3, $4, 'TORRES_OST')`, [ids.workspace, ids.org, workspaceSlug, `${tag} workspace`]);
    await pool.query(`INSERT INTO ${S}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'ADMIN')`, [ids.workspace, userId]);
    await pool.query(`INSERT INTO ${S}.okr_cycles (id, workspace_id, title, start_date, end_date) VALUES ($1, $2, $3, '2026-07-01', '2026-09-30')`, [ids.cycle, ids.workspace, `${tag} cycle`]);
    await pool.query(`INSERT INTO ${S}.objectives (id, workspace_id, cycle_id, title) VALUES ($1, $2, $3, $4)`, [ids.objective, ids.workspace, ids.cycle, `${tag} aim`]);
    await pool.query(`INSERT INTO ${S}.key_results (id, objective_id, title, target) VALUES ($1, $2, $3, 10)`, [ids.kr, ids.objective, `${tag} metric`]);
    await pool.query(`INSERT INTO ${S}.opportunities (id, workspace_id, title) VALUES ($1, $2, $3)`, [ids.legacyOpp, ids.workspace, `${tag} legacy need`]);
    await pool.query(`INSERT INTO ${S}.solutions (id, workspace_id, opportunity_id, title) VALUES ($1, $2, $3, $4)`, [ids.solution, ids.workspace, ids.legacyOpp, `${tag} solution`]);
  });

  test.afterAll(async () => {
    if (!pool) return;
    try {
      // Everything here is synthetic and addressed by its own ids / workspace id. Link rows go first.
      await pool.query(`DELETE FROM ${S}.solution_key_result_links WHERE workspace_id = $1`, [ids.workspace]);
      await pool.query(`DELETE FROM ${S}.opportunity_objective_links WHERE workspace_id = $1`, [ids.workspace]);
      await pool.query(`DELETE FROM ${S}.solutions WHERE workspace_id = $1`, [ids.workspace]);
      await pool.query(`DELETE FROM ${S}.opportunities WHERE workspace_id = $1`, [ids.workspace]);
      await pool.query(`DELETE FROM ${S}.key_results WHERE id = $1`, [ids.kr]);
      await pool.query(`DELETE FROM ${S}.objectives WHERE id = $1`, [ids.objective]);
      await pool.query(`DELETE FROM ${S}.okr_cycles WHERE id = $1`, [ids.cycle]);
      await pool.query(`DELETE FROM ${S}.workspace_members WHERE workspace_id = $1`, [ids.workspace]);
      await pool.query(`DELETE FROM ${S}.workspaces WHERE id = $1`, [ids.workspace]);
      await pool.query(`DELETE FROM ${S}.organization_members WHERE organization_id = $1`, [ids.org]);
      await pool.query(`DELETE FROM ${S}.organizations WHERE id = $1`, [ids.org]);
    } finally {
      await pool.end();
    }
  });

  test("TORRES_OST: the Solution panel's picker links a success metric", async ({ page }) => {
    await setModel("TORRES_OST");
    await page.goto(`${base}/discovery?detail=solution:${ids.solution}`);
    await page.waitForLoadState("networkidle");
    const picker = page.getByTestId("solution-key-result-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Linked Success metrics")).toBeVisible();
    await expect(picker).toContainText("No success metrics linked.");
    expect(await count("solution_key_result_links", "solution_id = $2", [ids.solution])).toBe(0);

    await picker.getByRole("button", { name: "Choose success metrics" }).click();
    await page.getByRole("menuitemcheckbox", { name: new RegExp(`${tag} metric`) }).click();
    await expect(picker.getByRole("listitem")).toContainText(`${tag} metric`, { timeout: 15_000 });

    // The write is a typed link stamped with the solution's workspace and the UI source.
    expect(await count("solution_key_result_links", "solution_id = $2 AND key_result_id = $3 AND source = 'UI'", [ids.solution, ids.kr])).toBe(1);
  });

  test("TORRES_OST: the Success metric panel lists the linked solution, read-only", async ({ page }) => {
    await setModel("TORRES_OST");
    await page.goto(`${base}/discovery?detail=keyResult:${ids.kr}`);
    await page.waitForLoadState("networkidle");
    const list = page.getByTestId("linked-solutions");
    await expect(list).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Linked Solutions")).toBeVisible();
    await expect(list.getByRole("button", { name: new RegExp(`${tag} solution`) })).toBeVisible();
    await expect(list.getByRole("combobox")).toHaveCount(0);
    // It opens the solution's panel, where the link can be changed.
    await list.getByRole("button", { name: new RegExp(`${tag} solution`) }).click();
    await expect(page.getByTestId("solution-key-result-picker")).toBeVisible({ timeout: 30_000 });
  });

  test("TORRES_OST: the composer creates an opportunity linked to an outcome in one step", async ({ page }) => {
    await setModel("TORRES_OST");
    await page.goto(`${base}/discovery?detail=opportunity-new:new`);
    await page.waitForLoadState("networkidle");
    const field = page.getByTestId("composer-objective-field");
    await expect(field).toBeVisible({ timeout: 30_000 });
    await expect(field).toContainText("Outcomes");

    await page.getByLabel("Title").fill(composedTitle);
    await field.getByRole("combobox", { name: "Outcomes" }).click();
    await page.getByRole("option", { name: `${tag} aim` }).click();
    await page.keyboard.press("Escape");
    await expect(field.getByRole("list", { name: "Selected outcomes" })).toContainText(`${tag} aim`);
    await page.getByRole("button", { name: "Submit" }).click();

    await expect
      .poll(async () => (await pool.query(`SELECT id FROM ${S}.opportunities WHERE workspace_id = $1 AND title = $2`, [ids.workspace, composedTitle])).rowCount, { timeout: 30_000 })
      .toBe(1);
    composedOpp = (await pool.query(`SELECT id FROM ${S}.opportunities WHERE workspace_id = $1 AND title = $2`, [ids.workspace, composedTitle])).rows[0].id;
    // One DIRECT link, from the same create, stamped with the opportunity's workspace; the legacy pointer is untouched.
    expect(await count("opportunity_objective_links", "opportunity_id = $2 AND objective_id = $3 AND origin = 'DIRECT' AND source = 'UI'", [composedOpp, ids.objective])).toBe(1);
    const pointer = await pool.query(`SELECT linked_key_result_id FROM ${S}.opportunities WHERE id = $1`, [composedOpp]);
    expect(pointer.rows[0].linked_key_result_id).toBeNull();
  });

  test("linking through the legacy key result combobox dual-writes exactly one LEGACY link", async ({ page }) => {
    // CLASSIC: link the other opportunity through the legacy key result combobox (the dual-write creates a LEGACY link).
    await setModel(null);
    await page.goto(`${base}/discovery/${ids.legacyOpp}`);
    await page.waitForLoadState("networkidle");
    await page.getByText("Link to key result").click();
    await page.getByRole("option", { name: new RegExp(`${tag} metric`) }).click();
    await expect(page.getByText("change KR")).toBeVisible({ timeout: 15_000 });
    expect(await count("opportunity_objective_links", "opportunity_id = $2 AND origin = 'LEGACY'", [ids.legacyOpp])).toBe(1);
  });

  test("CLASSIC: no picker, no linked-solutions list, no composer field", async ({ page }) => {
    await setModel(null);
    await page.goto(`${base}/discovery?detail=solution:${ids.solution}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: `${tag} solution` }).or(page.getByText(`${tag} solution`).first())).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("solution-key-result-picker")).toHaveCount(0);

    await page.goto(`${base}/discovery?detail=keyResult:${ids.kr}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(`${tag} metric`).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("linked-solutions")).toHaveCount(0);

    await page.goto(`${base}/discovery?detail=opportunity-new:new`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByLabel("Title")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("composer-objective-field")).toHaveCount(0);
  });

  test("OPPORTUNITY_FIRST_OKR: the picker speaks Key Result", async ({ page }) => {
    await setModel("OPPORTUNITY_FIRST_OKR");
    await page.goto(`${base}/discovery?detail=solution:${ids.solution}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("solution-key-result-picker")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Linked Key Results")).toBeVisible();
    await expect(page.getByTestId("solution-key-result-picker").getByRole("listitem")).toContainText(`${tag} metric`);
  });

  test("TORRES_OST: unlinking through the picker removes the edge", async ({ page }) => {
    await setModel("TORRES_OST");
    await page.goto(`${base}/discovery?detail=solution:${ids.solution}`);
    await page.waitForLoadState("networkidle");
    const picker = page.getByTestId("solution-key-result-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await picker.getByRole("button", { name: "Choose success metrics" }).click();
    await page.getByRole("menuitemcheckbox", { name: new RegExp(`${tag} metric`) }).click();
    await expect(picker).toContainText("No success metrics linked.", { timeout: 15_000 });
    expect(await count("solution_key_result_links", "solution_id = $2", [ids.solution])).toBe(0);
  });
});
