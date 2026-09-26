/**
 * Opportunity composer functional spec.
 *
 * Journey: on the Discovery board, a column's "Add opportunity" opens the
 * composer docked in the right-hand panel slot with that column's status
 * preset (the board stays visible beside it) → write a title and a Markdown
 * description (with the one-click outline), link a Key Result and seed it
 * from existing feedback → submit with ⌘/Ctrl+Enter → the card appears on the
 * board, and the same panel slot now shows the created opportunity with its
 * KR and linked feedback. The rail's "New Opportunity" opens the same
 * composer and no longer navigates to the full page.
 *
 * Replaces the old inline column form. See
 * components/discovery/opportunity-composer.tsx.
 */
import pg from "pg";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import { createOpportunityFromBoard } from "../fixtures/opportunity-composer";

const S = "compass_dev";

async function withPool<T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}

/** One Key Result and two unlinked feedback items, all uniquely titled. */
async function seedLinkTargets(stamp: number) {
  return withPool(async (pool) => {
    const { rows: [workspace] } = await pool.query(`SELECT w.id, c.id AS cycle_id
      FROM ${S}.workspaces w JOIN ${S}.organizations o ON o.id = w.organization_id
      JOIN ${S}.okr_cycles c ON c.workspace_id = w.id
      WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace' LIMIT 1`);
    if (!workspace) throw new Error("E2E workspace (with an OKR cycle) has not been seeded");
    const krTitle = `E2E Composer KR ${stamp}`;
    const { rows: [objective] } = await pool.query(
      `INSERT INTO ${S}.objectives (id, cycle_id, title) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
      [workspace.cycle_id, `E2E Composer Objective ${stamp}`],
    );
    await pool.query(
      `INSERT INTO ${S}.key_results (id, objective_id, title, target, current) VALUES (gen_random_uuid(), $1, $2, 40, 10)`,
      [objective.id, krTitle],
    );
    const feedbackTitles = [`E2E Seed Signal A ${stamp}`, `E2E Seed Signal B ${stamp}`];
    for (const title of feedbackTitles) {
      await pool.query(
        `INSERT INTO ${S}.feedback (id, workspace_id, title, type, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'IDEA', 'OPEN', NOW(), NOW())`,
        [workspace.id, title],
      );
    }
    return { krTitle, feedbackTitles };
  });
}

async function feedbackLinks(titles: string[]) {
  return withPool(async (pool) => {
    const { rows } = await pool.query(
      `SELECT title, opportunity_id, status FROM ${S}.feedback WHERE title = ANY($1) ORDER BY title`,
      [titles],
    );
    return rows as Array<{ title: string; opportunity_id: string | null; status: string }>;
  });
}

async function openColumnComposer(page: Page, column: number) {
  await page.getByRole("button", { name: /Add opportunity/i }).nth(column).click();
  const composer = page.locator('[data-slot="opportunity-composer"]');
  await expect(composer).toBeVisible();
  return composer;
}

test.describe("Opportunity composer panel", () => {
  test("creates a linked, Markdown opportunity from a docked panel and hands the slot to it", async ({ page, base }) => {
    const stamp = Date.now();
    const title = `E2E Composer Opportunity ${stamp}`;
    const { krTitle, feedbackTitles } = await seedLinkTargets(stamp);

    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");

    // The Validating column's button presets Validating.
    const composer = await openColumnComposer(page, 1);
    await expect(page).toHaveURL(/detail=opportunity-new%3Anew-validating/);
    await expect(page.locator('[data-slot="pinned-panel"]')).toContainText("New opportunity");
    await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
    // The board is still usable beside the composer.
    await expect(page.getByRole("button", { name: /Add opportunity/i }).first()).toBeEnabled();
    await expect(composer.getByRole("combobox", { name: "Status" })).toHaveText(/Validating/);

    await expect(composer.getByLabel("Title")).toBeFocused();
    await composer.getByLabel("Title").fill(title);
    await composer.getByLabel(/Customer segment/).fill("SMB admins");

    await composer.getByRole("button", { name: "Insert opportunity outline" }).click();
    for (const heading of ["Who's affected", "Current pain", "Evidence", "Desired outcome"]) {
      await expect(composer.getByRole("heading", { name: heading })).toBeVisible();
    }
    await composer.getByRole("button", { name: "Markdown", exact: true }).click();
    await composer
      .getByLabel("Description Markdown source")
      .fill("## Who's affected\n\nNew **workspace admins**\n\n## Evidence\n\nTwo support threads");

    await composer.getByRole("combobox", { name: "Key result" }).click();
    await page.getByPlaceholder("Search key results…").fill(krTitle);
    await page.getByRole("option", { name: new RegExp(krTitle) }).click();
    await expect(composer.getByRole("combobox", { name: "Key result" })).toContainText(krTitle);

    await composer.getByRole("combobox", { name: "Seed from feedback" }).click();
    const search = page.getByPlaceholder("Search feedback…");
    await search.fill(`E2E Seed Signal A ${stamp}`);
    await page.getByRole("option", { name: new RegExp(feedbackTitles[0]) }).click();
    await search.fill(`E2E Seed Signal B ${stamp}`);
    await page.getByRole("option", { name: new RegExp(feedbackTitles[1]) }).click();
    await page.keyboard.press("Escape");
    const chips = composer.getByRole("list", { name: "Selected feedback" });
    await expect(chips.getByRole("listitem")).toHaveCount(2);

    await composer.getByLabel("Title").press("ControlOrMeta+Enter");

    // The composer is replaced in the same slot by the created opportunity.
    await expect(page).toHaveURL(/detail=opportunity%3A[0-9a-f-]{36}/, { timeout: 30_000 });
    const opportunityId = decodeURIComponent(new URL(page.url()).searchParams.get("detail")!).split(":")[1];
    const panel = page.locator('[data-slot="pinned-panel"]');
    await expect(panel.getByText(title, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole("button", { name: krTitle, exact: true })).toBeVisible();
    await expect(panel.getByText("Linked feedback (2)", { exact: true })).toBeVisible();
    await expect(panel.locator("strong", { hasText: "workspace admins" })).toBeVisible();
    await expect(panel).not.toContainText("**workspace admins**");

    // Persisted: the feedback now points at the new opportunity, status unchanged.
    const links = await feedbackLinks(feedbackTitles);
    expect(links.map((row) => row.opportunity_id)).toEqual([opportunityId, opportunityId]);
    expect(links.map((row) => row.status)).toEqual(["OPEN", "OPEN"]);

    // Created with the preset status, and on the board.
    await expect(panel.getByRole("combobox").filter({ hasText: "Validating" }).first()).toBeVisible();
    await expect(
      page.getByLabel("Opportunity board").getByRole("button", { name: title, exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Back does not return to an emptied composer: the hand-off replaced it.
    await page.goBack();
    await expect(page.locator('[data-slot="opportunity-composer"]')).toHaveCount(0);
  });

  test("keeps the draft across a reload and Esc, and only discards it after confirmation", async ({ page, base }) => {
    const title = `E2E Opportunity Draft ${Date.now()}`;
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");

    let composer = await openColumnComposer(page, 0);
    await composer.getByLabel("Title").fill(title);
    await page.reload();
    await page.waitForLoadState("networkidle");

    composer = page.locator('[data-slot="opportunity-composer"]');
    await expect(composer.getByLabel("Title")).toHaveValue(title);
    await expect(composer.getByText("Restored your unsent draft.")).toBeVisible();

    // Esc closes the panel but keeps the draft.
    await composer.getByLabel("Title").press("Escape");
    await expect(page.locator('[data-slot="opportunity-composer"]')).toHaveCount(0);
    composer = await openColumnComposer(page, 2);
    await expect(composer.getByLabel("Title")).toHaveValue(title);
    // A different column's button re-presets the status but keeps the text.
    await expect(composer.getByRole("combobox", { name: "Status" })).toHaveText(/Prioritized/);

    await composer.getByRole("button", { name: "Cancel", exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Discard this draft?");
    await confirm.getByRole("button", { name: "Keep editing" }).click();
    await expect(composer.getByLabel("Title")).toHaveValue(title);

    await composer.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Discard draft" }).click();
    await expect(page.locator('[data-slot="opportunity-composer"]')).toHaveCount(0);

    composer = await openColumnComposer(page, 0);
    await expect(composer.getByLabel("Title")).toHaveValue("");
    await expect(page.getByRole("button", { name: title, exact: true })).toHaveCount(0);
  });

  test("the rail's New Opportunity opens the composer in place instead of navigating away", async ({ page, base }) => {
    const stamp = Date.now();
    const anchor = `E2E Rail Anchor ${stamp}`;
    const created = `E2E Rail Composer ${stamp}`;
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    const anchorId = await createOpportunityFromBoard(page, anchor);

    await page.goto(`${base}/discovery/${anchorId}`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New Opportunity", exact: true }).click();
    const composer = page.locator('[data-slot="opportunity-composer"]');
    await expect(composer).toBeVisible();
    await expect(composer.getByRole("combobox", { name: "Status" })).toHaveText(/Exploring/);
    await composer.getByLabel("Title").fill(created);
    await composer.getByRole("button", { name: "Submit", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/discovery/${anchorId}\\?.*detail=opportunity%3A[0-9a-f-]{36}`), {
      timeout: 30_000,
    });
    await expect(page.locator('[data-slot="pinned-panel"]').getByText(created, { exact: true })).toBeVisible();
    // The rail refreshed to include it.
    await expect(page.getByRole("link", { name: created })).toBeVisible({ timeout: 15_000 });
  });

  test.describe("mobile", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("opens as a full-width sheet and hands off to the created opportunity", async ({ page, base }) => {
      const title = `E2E Composer Mobile ${Date.now()}`;
      await page.goto(`${base}/discovery`);
      await page.waitForLoadState("networkidle");

      const composer = await openColumnComposer(page, 0);
      await expect(page.locator('[data-slot="pinned-panel"]')).toHaveCount(0);
      const sheet = page.locator('[data-slot="sheet-content"]');
      await expect(sheet).toContainText("New opportunity");
      const box = await sheet.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(385);

      await composer.getByLabel("Title").fill(title);
      await composer.getByRole("button", { name: "Submit", exact: true }).click();
      await expect(page).toHaveURL(/detail=opportunity%3A[0-9a-f-]{36}/, { timeout: 30_000 });
      await expect(sheet.getByText(title, { exact: true })).toBeVisible({ timeout: 15_000 });
    });

    test("the mobile rail's New Opportunity swaps the rail panel for the composer", async ({ page, base }) => {
      const stamp = Date.now();
      const anchor = `E2E Mobile Rail Anchor ${stamp}`;
      const created = `E2E Mobile Rail Composer ${stamp}`;
      await page.goto(`${base}/discovery`);
      await page.waitForLoadState("networkidle");
      const anchorId = await createOpportunityFromBoard(page, anchor);

      await page.goto(`${base}/discovery/${anchorId}`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "Browse opportunities" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "New Opportunity", exact: true }).click();

      const composer = page.locator('[data-slot="opportunity-composer"]');
      await expect(composer).toBeVisible();
      await expect(page).toHaveURL(/detail=opportunity-new%3Anew/);
      await composer.getByLabel("Title").fill(created);
      await composer.getByRole("button", { name: "Submit", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/discovery/${anchorId}\\?.*detail=opportunity%3A[0-9a-f-]{36}`), {
        timeout: 30_000,
      });
      await expect(page.locator('[data-slot="sheet-content"]').getByText(created, { exact: true })).toBeVisible();

      // The rail panel was replaced, not stacked: Back leaves the panel slot.
      await page.goBack();
      await expect(page).not.toHaveURL(/detail=/);
    });
  });
});
