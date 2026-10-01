/**
 * Phase 4C-1, end to end: an Objective with NO cycle (migration 070) under the Torres thinking model.
 *
 * Journey (one serial flow over the shared e2e workspace): create the cycle-less Outcome through the
 * UI at /okrs/none, see it in the Outcomes index (and NOT as the "No cycle / Persistent" card), see it
 * as a root of the workspace tree with no cycle chip, link an opportunity to it through the picker,
 * then delete it from its card and check the link is gone and the opportunity returned to the pool.
 * A last test shows CLASSIC still renders the "No cycle / Persistent" card and no Outcomes index.
 *
 * Fixtures: `workspaces.thinking_model` is set with raw SQL and always restored to NULL (CLASSIC), because
 * every other functional spec relies on CLASSIC copy. The synthetic opportunity is inserted by id and removed
 * by id. The cycle-less Outcome is created through the app and cleaned up by id. No test inserts or updates a
 * link table: the edge is created by the picker (lib/typed-links.ts); raw SQL only counts and deletes link rows.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/index";
import { E2E_SCHEMA, isolatedE2EConnectionString } from "../fixtures/isolated-database";

const S = `"${E2E_SCHEMA}"`;

test.describe.serial("Optional cycle under Torres", () => {
  test.setTimeout(180_000);
  const opportunityId = randomUUID();
  const tag = `OCT ${Date.now()}`;
  const outcomeTitle = `${tag} persistent outcome`;
  let pool: pg.Pool;
  let workspaceId: string;
  let outcomeId = "";

  async function setModel(key: string | null) {
    await pool.query(`UPDATE ${S}.workspaces SET thinking_model = $1, thinking_model_labels = NULL WHERE id = $2`, [key, workspaceId]);
  }

  /** Count only: raw SQL may count and delete link rows here, never insert or update them. */
  async function countLinks() {
    const result = await pool.query(
      `SELECT count(*)::int AS n FROM ${S}.opportunity_objective_links WHERE opportunity_id = $1 AND objective_id = $2`,
      [opportunityId, outcomeId],
    );
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
    await pool.query(`INSERT INTO ${S}.opportunities (id, workspace_id, title) VALUES ($1, $2, $3)`, [opportunityId, workspaceId, `${tag} need`]);
  });

  test.afterEach(async () => {
    await setModel(null);
  });

  test.afterAll(async () => {
    if (!pool) return;
    try {
      await setModel(null);
      // Rows are removed by id. Link rows first (no foreign key reaches them).
      const ids = (
        await pool.query(`SELECT id FROM ${S}.objectives WHERE workspace_id = $1 AND title = $2`, [workspaceId, outcomeTitle])
      ).rows.map((row) => row.id as string);
      if (outcomeId) ids.push(outcomeId);
      await pool.query(`DELETE FROM ${S}.opportunity_objective_links WHERE workspace_id = $1 AND (opportunity_id = $2 OR objective_id = ANY($3::uuid[]))`, [
        workspaceId,
        opportunityId,
        ids,
      ]);
      await pool.query(`DELETE FROM ${S}.objectives WHERE id = ANY($1::uuid[])`, [ids]);
      await pool.query(`DELETE FROM ${S}.opportunities WHERE id = $1`, [opportunityId]);
    } finally {
      await pool.end();
    }
  });

  test("TORRES_OST: a cycle-less Outcome is created at /okrs/none and appears once, in the Outcomes index", async ({ page, base }) => {
    await setModel("TORRES_OST");

    // The quiet entry point to the cycle-less page is on the Outcomes page; it is the only one.
    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("persistent-objectives-card")).toHaveCount(0);
    await page.getByTestId("persistent-objectives-link").click();
    await expect(page).toHaveURL(/\/okrs\/none$/);
    await expect(page.getByRole("heading", { name: "No cycle / Persistent" })).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Add outcome" }).click();
    await page.getByLabel("Title").fill(outcomeTitle);
    await page.getByRole("button", { name: "Add outcome" }).click();
    await expect(page.getByText(outcomeTitle)).toBeVisible({ timeout: 15_000 });

    const row = (await pool.query(`SELECT id, cycle_id, workspace_id FROM ${S}.objectives WHERE title = $1`, [outcomeTitle])).rows;
    expect(row).toHaveLength(1);
    expect(row[0].cycle_id).toBeNull();
    expect(row[0].workspace_id).toBe(workspaceId);
    outcomeId = row[0].id;

    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");
    const indexRow = page.getByTestId(`outcomes-index-row-${outcomeId}`);
    await expect(indexRow).toContainText(outcomeTitle);
    await expect(indexRow).toContainText("0 linked opportunities");
    await expect(page.getByTestId(`outcomes-index-cycle-${outcomeId}`)).toHaveCount(0);
    // Not rendered twice: there is still no "No cycle / Persistent" card under Torres.
    await expect(page.getByTestId("persistent-objectives-card")).toHaveCount(0);
    await expect(page.getByText(outcomeTitle)).toHaveCount(1);
  });

  test("TORRES_OST: the tree shows it as a root with no cycle chip, and the picker links an opportunity to it", async ({ page, base }) => {
    await setModel("TORRES_OST");
    await page.goto(`${base}/discovery/tree`);
    const root = page.getByTestId(`outcome-root-${outcomeId}`);
    await expect(root).toContainText(outcomeTitle, { timeout: 30_000 });
    await expect(page.getByTestId(`outcome-cycle-${outcomeId}`)).toHaveCount(0);
    await expect(page.getByTestId(`outcome-pool-opportunity-${opportunityId}`)).toContainText(`${tag} need`);

    await page.goto(`${base}/discovery/${opportunityId}`);
    await page.waitForLoadState("networkidle");
    const picker = page.getByTestId("opportunity-objective-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    expect(await countLinks()).toBe(0);
    await picker.getByRole("button", { name: "Choose outcomes" }).click();
    // The picker lists the cycle-less Outcome like any other, with no cycle beside it.
    await page.getByRole("menuitemcheckbox", { name: new RegExp(outcomeTitle) }).click();
    await expect(picker.getByRole("listitem")).toContainText(outcomeTitle, { timeout: 15_000 });
    expect(await countLinks()).toBe(1);
    const link = (await pool.query(`SELECT workspace_id, origin, source FROM ${S}.opportunity_objective_links WHERE opportunity_id = $1 AND objective_id = $2`, [opportunityId, outcomeId])).rows[0];
    expect(link).toMatchObject({ workspace_id: workspaceId, origin: "DIRECT", source: "UI" });

    await page.goto(`${base}/discovery/tree`);
    await expect(page.getByTestId(`outcome-root-${outcomeId}`).getByTestId(`outcome-opportunity-${outcomeId}-${opportunityId}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`outcome-pool-opportunity-${opportunityId}`)).toHaveCount(0);

    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId(`outcomes-index-row-${outcomeId}`)).toContainText("1 linked opportunity");
  });

  test("TORRES_OST: deleting the cycle-less Outcome removes it and its link; the opportunity returns to the pool", async ({ page, base }) => {
    await setModel("TORRES_OST");
    await page.goto(`${base}/okrs/none`);
    await page.waitForLoadState("networkidle");
    const card = page
      .locator("div")
      .filter({ has: page.getByRole("button", { name: outcomeTitle, exact: true }) })
      .filter({ has: page.getByRole("button", { name: "Card actions" }) })
      .last();
    await card.getByRole("button", { name: "Card actions" }).first().click({ force: true });
    await page.getByRole("menuitem", { name: "Delete Outcome" }).click();
    await expect(page.getByText(outcomeTitle)).toHaveCount(0, { timeout: 20_000 });

    // The app's delete drains the link after the Objective row is gone (no foreign key does it).
    await expect.poll(async () => (await pool.query(`SELECT count(*)::int AS n FROM ${S}.objectives WHERE id = $1`, [outcomeId])).rows[0].n, { timeout: 15_000 }).toBe(0);
    await expect.poll(countLinks, { timeout: 15_000 }).toBe(0);

    await page.goto(`${base}/discovery/tree`);
    await expect(page.getByTestId(`outcome-pool-opportunity-${opportunityId}`)).toContainText(`${tag} need`, { timeout: 30_000 });
    await expect(page.getByTestId(`outcome-root-${outcomeId}`)).toHaveCount(0);
  });

  test("CLASSIC (NULL): a cycle-less Objective shows as the No cycle / Persistent card, with no Outcomes index", async ({ page, base }) => {
    // The Torres flow deleted its Outcome, so make a fresh cycle-less Objective through the app under CLASSIC.
    await setModel(null);
    await page.goto(`${base}/okrs/none`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Add objective" }).click();
    await page.getByLabel("Title").fill(outcomeTitle);
    await page.getByRole("button", { name: "Add objective" }).click();
    await expect(page.getByText(outcomeTitle)).toBeVisible({ timeout: 15_000 });
    outcomeId = (await pool.query(`SELECT id FROM ${S}.objectives WHERE title = $1`, [outcomeTitle])).rows[0].id;

    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");
    const card = page.getByTestId("persistent-objectives-card");
    await expect(card).toContainText("No cycle / Persistent");
    await expect(card).toContainText("Objectives not tied to a planning period");
    await expect(page.getByTestId("outcomes-index")).toHaveCount(0);
    await expect(page.getByTestId("persistent-objectives-link")).toHaveCount(0);
  });
});
