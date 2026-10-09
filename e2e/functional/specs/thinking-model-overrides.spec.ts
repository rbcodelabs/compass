/**
 * Thinking model (Phase 4C-2): a workspace admin renames ALL FIVE entities in Settings and the whole workspace follows;
 * clearing the names restores today's CLASSIC text.
 *
 * The overrides are written through the settings UI, never with SQL: the form, the server action and the resolver are
 * what is under test. The only direct SQL is cleanup, by the ids and titles this spec created, plus resetting the
 * workspace to NULL (CLASSIC) because every other functional spec relies on CLASSIC copy and this suite is serialized
 * over one shared workspace.
 *
 * Journey: build an Opportunity, a Solution, a Cycle and an Objective under CLASSIC and note today's text -> rename
 * Opportunity/Objective/Key Result/Solution/Cycle -> check the nav, the Discovery board (button, group-by, swimlane
 * empty-state words), the opportunity panel, the OKRs page and an inline error under the
 * override -> clear the names and check CLASSIC is back, unchanged.
 */
import pg from "pg";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";
import { createOpportunityFromBoard } from "../fixtures/opportunity-composer";
import { E2E_SCHEMA, isolatedE2EConnectionString } from "../fixtures/isolated-database";

const NAMES = {
  Opportunity: ["Problem", "Problems"],
  Objective: ["Aim", "Aims"],
  "Key Result": ["Signal", "Signals"],
  Solution: ["Bet", "Bets"],
  Cycle: ["Sprint", "Sprints"],
} as const;

async function withPool<T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}

async function resetWorkspaceToClassic() {
  await withPool((pool) =>
    pool.query(
      `UPDATE "${E2E_SCHEMA}".workspaces
          SET thinking_model = NULL, thinking_model_labels = NULL
        WHERE slug = 'e2e-workspace'
          AND organization_id = (SELECT id FROM "${E2E_SCHEMA}".organizations WHERE slug = 'e2e-test-org')`,
    ),
  );
}

/**
 * Remove exactly what this run created, by id / unique title: the rows, and the workspace-update events written for them
 * (WORKSPACE_UPDATES_ENABLED is on for the e2e server, so creating an entity appends an event keyed by its id).
 */
async function cleanup(created: { opportunityId?: string; cycleTitle: string }) {
  await withPool(async (pool) => {
    const ids: string[] = []
    if (created.opportunityId) {
      const solutions = await pool.query(`SELECT id FROM "${E2E_SCHEMA}".solutions WHERE opportunity_id = $1`, [created.opportunityId])
      ids.push(created.opportunityId, ...solutions.rows.map((row) => row.id))
      await pool.query(`DELETE FROM "${E2E_SCHEMA}".solutions WHERE opportunity_id = $1`, [created.opportunityId])
      await pool.query(`DELETE FROM "${E2E_SCHEMA}".opportunities WHERE id = $1`, [created.opportunityId])
    }
    const cycle = await pool.query(`SELECT id FROM "${E2E_SCHEMA}".okr_cycles WHERE title = $1`, [created.cycleTitle])
    for (const { id } of cycle.rows) {
      ids.push(id)
      const objectives = await pool.query(`SELECT id FROM "${E2E_SCHEMA}".objectives WHERE cycle_id = $1`, [id])
      for (const objective of objectives.rows) {
        ids.push(objective.id)
        await pool.query(`DELETE FROM "${E2E_SCHEMA}".key_results WHERE objective_id = $1`, [objective.id])
        await pool.query(`DELETE FROM "${E2E_SCHEMA}".objectives WHERE id = $1`, [objective.id])
      }
      await pool.query(`DELETE FROM "${E2E_SCHEMA}".okr_cycles WHERE id = $1`, [id])
    }
    if (ids.length > 0) {
      await pool.query(`DELETE FROM "${E2E_SCHEMA}".workspace_update_events WHERE entity_id = ANY($1::uuid[]) OR group_id = ANY($1::uuid[])`, [ids])
    }
  })
}

async function saveNames(page: Page, base: string, names: Partial<Record<keyof typeof NAMES, readonly [string, string]>>) {
  await page.goto(`${base}/settings`);
  await page.waitForLoadState("networkidle");
  const panel = page.getByTestId("thinking-model-panel");
  await panel.scrollIntoViewIfNeeded();
  for (const entity of Object.keys(NAMES) as Array<keyof typeof NAMES>) {
    const [singular, plural] = names[entity] ?? ["", ""];
    await panel.getByLabel(`${entity} (singular)`).fill(singular);
    await panel.getByLabel(`${entity} (plural)`).fill(plural);
  }
  await panel.getByTestId("thinking-model-save").click();
  await expect(panel.getByText("Saved.")).toBeVisible({ timeout: 15_000 });
}

test.describe("Thinking model overrides (all five entities)", () => {
  const ts = Date.now();
  const cycleTitle = `TMO Period ${ts}`;
  const objectiveTitle = `TMO Goal ${ts}`;
  const oppTitle = `TMO Alpha ${ts}`;
  const solutionTitle = `TMO Beta ${ts}`;
  let opportunityId: string | undefined;

  test.afterAll(async () => {
    await resetWorkspaceToClassic();
    await cleanup({ opportunityId, cycleTitle });
  });

  test("renaming all five entities in Settings reaches the nav, board, panel, OKRs page and an inline error; clearing restores CLASSIC", async ({
    page,
    base,
  }) => {
    test.setTimeout(240_000);
    await resetWorkspaceToClassic();

    // ── CLASSIC: build the data and note today's text ───────────────────────────────────────────────────────────
    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New Cycle" }).click();
    await page.getByLabel("Title").fill(cycleTitle);
    await page.getByLabel("Start date").fill("2026-07-01");
    await page.getByLabel("End date").fill("2026-09-30");
    await page.getByRole("button", { name: "Create cycle" }).click();
    await expect(page.getByRole("main").first().getByText(cycleTitle)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("main").first().getByText(cycleTitle).click();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Add objective" }).click();
    await page.getByLabel("Title").fill(objectiveTitle);
    await page.getByRole("button", { name: "Add objective" }).click();
    await expect(page.getByText(objectiveTitle)).toBeVisible({ timeout: 10_000 });

    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    opportunityId = await createOpportunityFromBoard(page, oppTitle);
    await page.getByRole("button", { name: oppTitle, exact: true }).click();
    const classicPanel = page.locator('[data-slot="sheet-content"]');
    await classicPanel.getByRole("button", { name: "Add Solution" }).click();
    await classicPanel.getByLabel("Title").fill(solutionTitle);
    await classicPanel.getByRole("button", { name: "Add Solution" }).click();
    await expect(classicPanel.getByText(solutionTitle)).toBeVisible({ timeout: 15_000 });
    await expect(classicPanel.getByRole("tab", { name: /^Solutions \(1\)/ })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /Add opportunity/i }).first()).toBeVisible();
    await expect(page.getByLabel("Opportunity board")).toBeVisible();

    // ── Rename all five through the settings form ───────────────────────────────────────────────────────────────
    await saveNames(page, base, NAMES);

    // Nav: the OKRs entry belongs to the model (Classic keeps "OKRs"); the rest of the workspace does not.
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: "OKRs", exact: true }).first()).toBeVisible();

    // Discovery board.
    await expect(page.getByRole("button", { name: /Add problem/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Add opportunity/i })).toHaveCount(0);
    await expect(page.getByLabel("Problem board")).toBeVisible();
    await page.getByLabel("Group board by").click();
    await expect(page.getByRole("option", { name: "Problem", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Opportunity", exact: true })).toHaveCount(0);
    await page.getByRole("option", { name: "Problem", exact: true }).click();
    // The swimlane's own words.
    await expect(page.getByLabel(`${oppTitle} bets`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/\b1 bet\b/).first()).toBeVisible();
    await page.getByLabel("Group board by").click();
    await page.getByRole("option", { name: "Status", exact: true }).click();

    // A panel: the opportunity.
    await page.getByRole("button", { name: oppTitle, exact: true }).click();
    const panel = page.locator('[data-slot="sheet-content"]');
    await expect(panel.getByRole("tab", { name: /^Bets \(1\)/ })).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole("button", { name: "Add Bet" })).toBeVisible();
    const panelText = await panel.innerText();
    expect(panelText).not.toMatch(/\bsolutions?\b/i);
    await page.keyboard.press("Escape");

    // OKRs page: cycle and objective words.
    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "New Sprint" })).toBeVisible();
    // Other specs leave cycles whose own titles say "Cycle"; that is data, not copy, so assert the page's own words.
    await expect(page.getByText("Track aims and signals across sprints.")).toBeVisible();
    await expect(page.getByText("No sprint / Persistent")).toBeVisible();
    await page.getByRole("main").first().getByText(cycleTitle).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "Add aim" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add objective" })).toHaveCount(0);

    // An inline error under the override: the composer's failure message names the renamed entity.
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /Add problem/i }).first().click();
    const composer = page.locator('[data-slot="opportunity-composer"]');
    await expect(composer).toBeVisible();
    await composer.getByLabel("Title").fill(`TMO failing ${ts}`);
    await page.route("**/*", async (route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) await route.abort();
      else await route.continue();
    });
    await composer.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(composer.getByText(/Couldn't create the problem right now/)).toBeVisible({ timeout: 15_000 });
    await page.unroute("**/*");

    // ── Clear the names: CLASSIC is back, unchanged ─────────────────────────────────────────────────────────────
    await saveNames(page, base, {});
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /Add opportunity/i }).first()).toBeVisible();
    await expect(page.getByLabel("Opportunity board")).toBeVisible();
    await page.getByRole("button", { name: oppTitle, exact: true }).click();
    await expect(page.locator('[data-slot="sheet-content"]').getByRole("tab", { name: /^Solutions \(1\)/ })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "New Cycle" })).toBeVisible();
  });
});
