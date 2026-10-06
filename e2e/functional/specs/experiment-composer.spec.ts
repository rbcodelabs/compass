/**
 * Experiment composer functional spec.
 *
 * Journey: on the Experiments board, "New Experiment" opens the composer
 * docked in the right-hand panel slot (the board stays visible beside it) →
 * title, Hypothesis, Method and Kill Condition are all required → submit with
 * the button or ⌘/Ctrl+Enter → the same panel slot now shows the created
 * experiment and the card is on the board. Cancel keeps the draft until the
 * user confirms discarding it, and the OST "Test this assumption" link opens
 * the composer with that assumption already selected.
 *
 * Replaces the old inline CreateExperimentForm. See
 * components/experiments/experiment-composer.tsx.
 */
import pg from "pg";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";

const S = "compass_dev";

/** One opportunity → solution → assumption chain in the seeded E2E workspace. */
async function seedAssumption(stamp: number) {
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  try {
    const { rows: [workspace] } = await pool.query(`SELECT w.id
      FROM ${S}.workspaces w JOIN ${S}.organizations o ON o.id = w.organization_id
      WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace' LIMIT 1`);
    if (!workspace) throw new Error("E2E workspace has not been seeded");
    const { rows: [opportunity] } = await pool.query(
      `INSERT INTO ${S}.opportunities (id, workspace_id, title, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'EXPLORING', NOW(), NOW()) RETURNING id`,
      [workspace.id, `E2E EC Opportunity ${stamp}`],
    );
    const { rows: [solution] } = await pool.query(
      `INSERT INTO ${S}.solutions (id, workspace_id, opportunity_id, title, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'IDEA', NOW(), NOW()) RETURNING id`,
      [workspace.id, opportunity.id, `E2E EC Solution ${stamp}`],
    );
    const title = `E2E EC Assumption ${stamp}`;
    const { rows: [assumption] } = await pool.query(
      `INSERT INTO ${S}.assumptions (id, solution_id, title, risk_level, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'HIGH', 'UNTESTED', NOW(), NOW()) RETURNING id`,
      [solution.id, title],
    );
    return { assumptionId: assumption.id as string, assumptionTitle: title };
  } finally {
    await pool.end();
  }
}

async function openComposer(page: Page) {
  await page.getByRole("button", { name: "New Experiment" }).click();
  const composer = page.locator('[data-slot="experiment-composer"]');
  await expect(composer).toBeVisible();
  return composer;
}

test.describe("Experiment composer panel", () => {
  test("opens docked beside the board and requires title, hypothesis, method and kill condition", async ({ page, base }) => {
    await page.goto(`${base}/experiments`);
    await page.waitForLoadState("networkidle");

    const composer = await openComposer(page);
    await expect(page).toHaveURL(/detail=experiment-new%3Anew/);
    await expect(page.locator('[data-slot="pinned-panel"]')).toContainText("New experiment");
    await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
    // The board is still usable beside the composer.
    await expect(page.getByRole("button", { name: "New Experiment" })).toBeEnabled();
    await expect(composer.getByLabel("Title")).toBeFocused();
    await expect(composer.getByText("Kill Condition", { exact: true })).toBeVisible();

    // Nothing filled in: the title is asked for first.
    await composer.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(composer.getByText("Add a title so your team can scan this at a glance.")).toBeVisible();
    await expect(composer.getByLabel("Title")).toHaveAttribute("aria-invalid", "true");
    await expect(composer.getByLabel("Hypothesis")).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/detail=experiment-new/);

    // Title alone is still not enough.
    await composer.getByLabel("Title").fill(`E2E Incomplete ${Date.now()}`);
    await composer.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(composer.getByText("Hypothesis, method and kill condition are all required.")).toBeVisible();
    await expect(composer.getByLabel("Method")).toHaveAttribute("aria-invalid", "true");
    await expect(composer.getByLabel("Kill Condition", { exact: true })).toHaveAttribute("aria-invalid", "true");

    // Filling a field clears its own error marker.
    await composer.getByLabel("Hypothesis").fill("We believe this is required.");
    await expect(composer.getByLabel("Hypothesis")).not.toHaveAttribute("aria-invalid", "true");
    await expect(composer.getByLabel("Method")).toHaveAttribute("aria-invalid", "true");
  });

  test("submits with Ctrl/Cmd+Enter and the panel becomes the created experiment's detail", async ({ page, base }) => {
    const title = `E2E Composer Experiment ${Date.now()}`;
    await page.goto(`${base}/experiments`);
    await page.waitForLoadState("networkidle");

    const composer = await openComposer(page);
    await composer.getByLabel("Title").fill(title);
    await composer.getByLabel("Hypothesis").fill("We believe the composer hands off.");
    await composer.getByLabel("Method").fill("Create one and watch the panel.");
    await composer.getByLabel("Kill Condition", { exact: true }).fill("Stop if the panel closes instead.");
    await composer.getByLabel("Kill Condition", { exact: true }).press("ControlOrMeta+Enter");

    // Same slot, now the experiment.
    await expect(page).toHaveURL(/detail=experiment%3A[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.locator('[data-slot="experiment-composer"]')).toHaveCount(0);
    const panel = page.locator('[data-slot="pinned-panel"]');
    await expect(panel.getByText(title, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(panel).toContainText("We believe the composer hands off.");
    await expect(panel).toContainText("Stop if the panel closes instead.");

    // And the card is on the board.
    await expect(page.getByLabel("Experiment board").getByRole("button", { name: title, exact: true })).toBeVisible({ timeout: 15_000 });

    // The sent draft is gone: reopening starts empty.
    await page.getByRole("button", { name: "New Experiment" }).click();
    await expect(page.locator('[data-slot="experiment-composer"]').getByLabel("Title")).toHaveValue("");

    // Back does not return to an emptied composer: the hand-off replaced it.
    await page.goBack();
    await expect(page.locator('[data-slot="experiment-composer"]')).toHaveCount(0);
  });

  test("keeps the draft across a reload and Esc, and only discards it after confirmation", async ({ page, base }) => {
    const title = `E2E Experiment Draft ${Date.now()}`;
    await page.goto(`${base}/experiments`);
    await page.waitForLoadState("networkidle");

    let composer = await openComposer(page);
    await composer.getByLabel("Title").fill(title);
    await page.reload();
    await page.waitForLoadState("networkidle");

    composer = page.locator('[data-slot="experiment-composer"]');
    await expect(composer.getByLabel("Title")).toHaveValue(title);
    await expect(composer.getByText("Restored your unsent draft.")).toBeVisible();

    // Esc closes the panel but keeps the draft.
    await composer.getByLabel("Title").press("Escape");
    await expect(page.locator('[data-slot="experiment-composer"]')).toHaveCount(0);
    composer = await openComposer(page);
    await expect(composer.getByLabel("Title")).toHaveValue(title);

    await composer.getByRole("button", { name: "Cancel", exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Discard this draft?");
    await confirm.getByRole("button", { name: "Keep editing" }).click();
    await expect(composer.getByLabel("Title")).toHaveValue(title);

    await composer.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Discard draft" }).click();
    await expect(page.locator('[data-slot="experiment-composer"]')).toHaveCount(0);

    composer = await openComposer(page);
    await expect(composer.getByLabel("Title")).toHaveValue("");
    await expect(page.getByRole("button", { name: title, exact: true })).toHaveCount(0);
  });

  test("Test this assumption opens the composer with that assumption preselected and links the experiment", async ({ page, base }) => {
    const stamp = Date.now();
    const title = `E2E Linked Experiment ${stamp}`;
    const { assumptionId, assumptionTitle } = await seedAssumption(stamp);

    // The OST link's target; the CTA itself is covered by assumption-experiment-linking.spec.ts.
    await page.goto(`${base}/experiments?assumptionId=${assumptionId}`);
    await page.waitForLoadState("networkidle");

    const composer = page.locator('[data-slot="experiment-composer"]');
    await expect(composer).toBeVisible();
    await expect(composer.getByRole("combobox").filter({ hasText: assumptionTitle })).toBeVisible({ timeout: 10_000 });

    await composer.getByLabel("Title").fill(title);
    await composer.getByLabel("Hypothesis").fill("We believe the assumption is carried over.");
    await composer.getByLabel("Method").fill("Submit and read the row back.");
    await composer.getByLabel("Kill Condition", { exact: true }).fill("Stop if the link is lost.");
    await composer.getByRole("button", { name: "Submit", exact: true }).click();

    await expect(page).toHaveURL(/detail=experiment%3A[0-9a-f-]{36}/, { timeout: 30_000 });
    const experimentId = decodeURIComponent(new URL(page.url()).searchParams.get("detail")!).split(":")[1];

    const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
    try {
      const { rows } = await pool.query(`SELECT assumption_id FROM ${S}.experiments WHERE id = $1`, [experimentId]);
      expect(rows[0]?.assumption_id).toBe(assumptionId);
    } finally {
      await pool.end();
    }
  });

  test.describe("mobile", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("opens as a full-width sheet and hands off to the created experiment", async ({ page, base }) => {
      const title = `E2E Composer Mobile ${Date.now()}`;
      await page.goto(`${base}/experiments`);
      await page.waitForLoadState("networkidle");

      const composer = await openComposer(page);
      await expect(page.locator('[data-slot="pinned-panel"]')).toHaveCount(0);
      const sheet = page.locator('[data-slot="sheet-content"]');
      await expect(sheet).toContainText("New experiment");
      const box = await sheet.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(385);

      await composer.getByLabel("Title").fill(title);
      await composer.getByLabel("Hypothesis").fill("Mobile hypothesis.");
      await composer.getByLabel("Method").fill("Mobile method.");
      await composer.getByLabel("Kill Condition", { exact: true }).fill("Mobile kill condition.");
      await composer.getByRole("button", { name: "Submit", exact: true }).click();
      await expect(page).toHaveURL(/detail=experiment%3A[0-9a-f-]{36}/, { timeout: 30_000 });
      await expect(sheet.getByText(title, { exact: true })).toBeVisible({ timeout: 15_000 });
    });
  });
});
