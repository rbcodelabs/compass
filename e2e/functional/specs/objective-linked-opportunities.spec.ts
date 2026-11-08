/**
 * Functional coverage for the read-only "Linked opportunities" section of the Objective detail panel
 * (components/panels/linked-opportunities-section.tsx).
 *
 * Fixtures only: every row is created in the seeded e2e workspace and removed (or restored) afterwards. The workspace is switched to the
 * Opportunity-first preset so objective<->opportunity links are offered, and its Opportunity scoring config is set per scenario. The
 * suite runs with one worker, so changing the workspace here cannot race another spec; afterAll restores what it changed.
 *
 *  - empty: an objective with nothing linked shows the empty line.
 *  - 20 rows: 17 via a key result + 2 direct + 1 both (linked both ways, so it dedupes) render in a height-bounded, scrollable
 *    container sorted by RAW score descending with unscored last, and the page does not scroll horizontally in a narrow viewport.
 *  - no model: with no active Opportunity scoring model the Score column is absent.
 */
import getPrisma from "../../../lib/db";
import pg from "pg";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

// Direct links are made through the Opportunity page's objective picker (the app's own writer, lib/typed-links.ts). Raw SQL here may
// only delete link rows (afterAll), never insert them, as in optional-cycle-thinking-model.spec.ts.
const SCHEMA = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";
async function linkViaPicker(page: Page, base: string, opportunityId: string, objectiveTitle: string) {
  await page.goto(`${base}/discovery/${opportunityId}`);
  const picker = page.getByTestId("opportunity-objective-picker");
  await expect(picker).toBeVisible({ timeout: 60_000 });
  await picker.getByRole("button", { name: /^Choose/ }).click();
  await page.getByRole("menuitemcheckbox", { name: new RegExp(objectiveTitle) }).click();
  await expect(picker.getByRole("listitem")).toContainText(objectiveTitle, { timeout: 15_000 });
  await page.keyboard.press("Escape");
}

const TAG = `LinkedOpps ${Date.now()}`;

type Seed = { workspaceId: string; orgId: string; objectiveIds: string[]; opportunityIds: string[]; modelId: string | null; previous: { thinkingModel: string | null } };
const seed: Seed = { workspaceId: "", orgId: "", objectiveIds: [], opportunityIds: [], modelId: null, previous: { thinkingModel: null } };

async function createObjective(title: string) {
  const objective = await getPrisma().objective.create({ data: { workspaceId: seed.workspaceId, title, status: "ON_TRACK" } });
  seed.objectiveIds.push(objective.id);
  return objective;
}

async function createOpportunity(title: string, raw: number | null, modelId: string | null) {
  const prisma = getPrisma();
  const opportunity = await prisma.opportunity.create({ data: { workspaceId: seed.workspaceId, title, status: "EXPLORING" } });
  seed.opportunityIds.push(opportunity.id);
  if (raw !== null && modelId) {
    await prisma.opportunityScore.create({
      data: { opportunityId: opportunity.id, scoringModelId: modelId, modelVersion: 1, formulaSnapshot: [], rawValues: {}, rawScore: raw, normalizedScore: Math.min(100, raw / 50) },
    });
  }
  return opportunity;
}

async function setScoringConfig(modelId: string | null) {
  const prisma = getPrisma();
  await prisma.workspaceScoringConfig.upsert({
    where: { workspaceId: seed.workspaceId },
    update: { opportunityScoringModelId: modelId },
    create: { workspaceId: seed.workspaceId, opportunityScoringModelId: modelId },
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ workspaceSlug }) => {
  const prisma = getPrisma();
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } });
  seed.workspaceId = workspace.id;
  seed.orgId = workspace.organizationId;
  seed.previous.thinkingModel = workspace.thinkingModel ?? null;
  await prisma.workspace.update({ where: { id: workspace.id }, data: { thinkingModel: "OPPORTUNITY_FIRST_OKR" } });
  const model = await prisma.scoringModel.create({
    data: { organizationId: seed.orgId, name: `${TAG} model`, formulaType: "MULTIPLICATIVE", version: 1 },
  });
  seed.modelId = model.id;
});

test.afterAll(async () => {
  const prisma = getPrisma();
  await prisma.workspaceScoringConfig.deleteMany({ where: { workspaceId: seed.workspaceId } });
  await prisma.workspace.update({ where: { id: seed.workspaceId }, data: { thinkingModel: seed.previous.thinkingModel } });
  if (seed.opportunityIds.length) await prisma.opportunityScore.deleteMany({ where: { opportunityId: { in: seed.opportunityIds } } });
  if (seed.objectiveIds.length) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query(`DELETE FROM "${SCHEMA}".opportunity_objective_links WHERE workspace_id = $1 AND objective_id = ANY($2::uuid[])`, [seed.workspaceId, seed.objectiveIds]);
    } finally {
      await pool.end();
    }
  }
  // Opportunities and objectives live under the e2e org, which global-teardown removes wholesale.
});

// The workspace is on the Opportunity-first preset for the first tests (set in beforeAll); the Torres test switches it and afterAll restores it.
const section = (page: import("@playwright/test").Page) => page.getByTestId("linked-opportunities");

test("empty objective shows the empty state", async ({ page, base }) => {
  await setScoringConfig(seed.modelId);
  const objective = await createObjective(`${TAG} empty objective`);
  await page.goto(`${base}/okrs?detail=${encodeURIComponent(`objective:${objective.id}`)}`);
  await expect(section(page)).toBeVisible({ timeout: 60_000 });
  await expect(section(page).getByText("No opportunities linked.")).toBeVisible();
  await expect(section(page).getByRole("table")).toHaveCount(0);
});

test("20 linked rows are bounded, scrollable and sorted by raw score with unscored last", async ({ page, base }) => {
  test.setTimeout(240_000);
  await setScoringConfig(seed.modelId);
  const objective = await createObjective(`${TAG} busy objective`);
  const keyResult = await getPrisma().keyResult.create({ data: { objectiveId: objective.id, title: `${TAG} KR`, target: 100, current: 0, unit: "%" } });

  const keyResult2 = await getPrisma().keyResult.create({ data: { objectiveId: objective.id, title: `${TAG} KR two`, target: 100, current: 0, unit: "%" } });
  // 17 linked through key results only. Raw scores reach 5,000 (multiplicative models): the headline must be the raw number.
  const viaKr: { id: string }[] = [];
  viaKr.push(await createOpportunity(`${TAG} opp kr-top`, 5000, seed.modelId));
  for (let i = 1; i <= 14; i++) viaKr.push(await createOpportunity(`${TAG} opp kr ${String(i).padStart(2, "0")}`, i * 250, seed.modelId));
  viaKr.push(await createOpportunity(`${TAG} opp u-2 kr`, null, seed.modelId));
  viaKr.push(await createOpportunity(`${TAG} opp u-3 kr`, null, seed.modelId));
  const krTargets = [keyResult.id, keyResult2.id];
  for (const [i, o] of viaKr.entries()) {
    await getPrisma().opportunity.update({ where: { id: o.id }, data: { linkedKeyResultId: krTargets[i % 2] } });
  }
  // 2 linked directly, and 1 linked both ways (must appear once).
  const directScored = await createOpportunity(`${TAG} opp direct 250`, 250, seed.modelId);
  const directUnscored = await createOpportunity(`${TAG} opp u-1 direct`, null, seed.modelId);
  const both = await createOpportunity(`${TAG} opp both`, 100, seed.modelId);
  await getPrisma().opportunity.update({ where: { id: both.id }, data: { linkedKeyResultId: keyResult.id } });
  for (const o of [directScored, directUnscored, both]) await linkViaPicker(page, base, o.id, `${TAG} busy objective`);

  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${base}/okrs?detail=${encodeURIComponent(`objective:${objective.id}`)}`);
  await expect(section(page)).toBeVisible({ timeout: 60_000 });

  const rows = section(page).getByTestId("linked-opportunity-row");
  await expect(rows).toHaveCount(20); // 17 via key results + 2 direct + 1 both (deduped)

  // Highest raw score first (5,000), the three unscored rows last, ordered by title.
  await expect(rows.first()).toContainText("opp kr-top");
  await expect(rows.first().getByTestId("linked-opportunity-score")).toContainText("5,000");
  await expect(rows.first().getByTestId("linked-opportunity-via")).toContainText("via Key Result");
  await expect(rows.nth(17)).toContainText("opp u-1 direct");
  await expect(rows.nth(19)).toContainText("opp u-3 kr");
  await expect(rows.filter({ hasText: "opp both" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "opp both" }).getByTestId("linked-opportunity-via")).toContainText("Direct");
  await expect(rows.filter({ hasText: "opp both" }).getByTestId("linked-opportunity-via")).toContainText("via Key Result");
  await expect(rows.nth(19).getByTestId("linked-opportunity-score")).toContainText("Not scored");
  await expect(section(page).getByTestId("linked-opportunity-via").filter({ hasText: "Direct" }).first()).toBeVisible();

  // Bounded height with its own scroll (not a page-long table) and a minimum table width (scrolls, never squashes).
  const metrics = await section(page).getByRole("region").evaluate((el) => ({
    scrollable: el.scrollHeight > el.clientHeight,
    maxHeight: el.clientHeight,
    tableMin: (el.querySelector("table") as HTMLElement).getBoundingClientRect().width,
  }));
  expect(metrics.scrollable).toBe(true);
  expect(metrics.maxHeight).toBeLessThanOrEqual(330);
  expect(metrics.tableMin).toBeGreaterThanOrEqual(384); // 24rem minimum

  // 390px: the Score (headline number) is the second column and is inside the visible region without scrolling.
  const region = section(page).getByRole("region");
  const narrow = await region.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const cell = el.querySelector('[data-testid="linked-opportunity-score"]')!.getBoundingClientRect();
    return { cellRight: cell.right, cellLeft: cell.left, regionRight: box.right, regionLeft: box.left, scrollLeft: el.scrollLeft };
  });
  expect(narrow.scrollLeft).toBe(0);
  expect(narrow.cellLeft).toBeGreaterThanOrEqual(narrow.regionLeft);
  expect(narrow.cellRight).toBeLessThanOrEqual(narrow.regionRight + 0.5);

  // 1440x900: with the Score column shown the table fits its region exactly (no horizontal overflow, no clipped header).
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(section(page).getByRole("columnheader", { name: "Score" })).toBeVisible();
  const wide = await section(page).getByRole("region").evaluate((el) => {
    const table = el.querySelector("table") as HTMLElement;
    const head = Array.from(el.querySelectorAll("th")).find((th) => th.textContent === "Score")!.getBoundingClientRect();
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, tableScroll: table.scrollWidth, headRight: head.right, regionRight: el.getBoundingClientRect().right };
  });
  expect(wide.scrollWidth).toBeLessThanOrEqual(wide.clientWidth);
  expect(wide.headRight).toBeLessThanOrEqual(wide.regionRight + 0.5);

  // The link goes to the opportunity page.
  await expect(rows.first().getByRole("link")).toHaveAttribute("href", /\/discovery\/[0-9a-f-]{36}$/);
});

test("score column is hidden when the workspace has no active Opportunity scoring model", async ({ page, base }) => {
  test.setTimeout(180_000);
  await setScoringConfig(null);
  const objective = await createObjective(`${TAG} unscored objective`);
  const opportunity = await createOpportunity(`${TAG} opp no-model`, 10, seed.modelId);
  await linkViaPicker(page, base, opportunity.id, `${TAG} unscored objective`);
  await page.goto(`${base}/okrs?detail=${encodeURIComponent(`objective:${objective.id}`)}`);
  await expect(section(page).getByRole("link", { name: `${TAG} opp no-model` })).toBeVisible({ timeout: 60_000 });
  await expect(section(page).getByRole("columnheader", { name: "Score" })).toHaveCount(0);
  await expect(section(page).getByTestId("linked-opportunity-score")).toHaveCount(0);
});

test("a Torres workspace still lists a key-result-linked opportunity (the preset never hides data)", async ({ page, base }) => {
  test.setTimeout(180_000);
  await setScoringConfig(seed.modelId);
  const prisma = getPrisma();
  await prisma.workspace.update({ where: { id: seed.workspaceId }, data: { thinkingModel: "TORRES_OST" } });
  const objective = await createObjective(`${TAG} torres objective`);
  const keyResult = await prisma.keyResult.create({ data: { objectiveId: objective.id, title: `${TAG} torres KR`, target: 10, current: 0, unit: null } });
  const viaKr = await createOpportunity(`${TAG} opp torres via-kr`, 777, seed.modelId);
  await prisma.opportunity.update({ where: { id: viaKr.id }, data: { linkedKeyResultId: keyResult.id } });
  await page.goto(`${base}/okrs?detail=${encodeURIComponent(`objective:${objective.id}`)}`);
  await expect(section(page).getByRole("link", { name: `${TAG} opp torres via-kr` })).toBeVisible({ timeout: 60_000 });
  await expect(section(page).getByTestId("linked-opportunity-score")).toContainText("777");
});
