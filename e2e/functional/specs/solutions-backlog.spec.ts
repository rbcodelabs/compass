/**
 * Solutions backlog functional spec.
 *
 * Discovery is the Opportunity backlog; /solutions is a flat board of every
 * Solution in the workspace, one column per SolutionStatus, so Solutions from
 * different Opportunities can be compared side by side.
 *
 * Journey:
 *   1. Create two Opportunities on the Discovery board, each with a Solution.
 *   2. Open Solutions from the sidebar: both Solutions sit in the same Idea
 *      column and each card links to its parent Opportunity.
 *   3. Drag one card to Validated; it lands there and survives a reload
 *      (status persisted via moveSolutionStatus).
 *   4. New solution, table view and group-by (see the second test).
 *   5. Discovery's Group by no longer offers "Opportunity", and a legacy
 *      `?groupBy=opportunity` link redirects to /solutions.
 *
 * dnd-kit's PointerSensor needs real mouse movement past its 8px activation
 * distance, so the drag uses page.mouse.* like the roadmap specs do.
 */
import { test, expect } from "../fixtures/index";
import { createOpportunityFromBoard } from "../fixtures/opportunity-composer";
import type { Locator, Page } from "@playwright/test";

async function dragTo(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error("drag source has no bounding box");
  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 15, startY + 15, { steps: 10 });

  await target.scrollIntoViewIfNeeded();
  const targetBox = await target.boundingBox();
  if (!targetBox) throw new Error("drag target has no bounding box");
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 20 });
  await page.mouse.up();
}

async function createOpportunityWithSolution(page: Page, opportunityTitle: string, solutionTitle: string) {
  await createOpportunityFromBoard(page, opportunityTitle);
  await expect(page.getByRole("button", { name: opportunityTitle, exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: opportunityTitle, exact: true }).click();
  const panel = page.locator('[data-slot="sheet-content"]');
  await panel.getByRole("button", { name: "Add Solution" }).click();
  await panel.getByLabel("Title").fill(solutionTitle);
  await panel.getByRole("button", { name: "Add Solution" }).click();
  await expect(panel.getByText(solutionTitle)).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible({ timeout: 10_000 });
}

function column(page: Page, status: string) {
  return page.locator(`[data-slot='solution-backlog-column'][data-status='${status}']`);
}

test.describe("Solutions backlog", () => {
  test("lists solutions from different opportunities in one column and persists a status drag", async ({ page, base }) => {
    const ts = Date.now();
    const oppA = `E2E Backlog Opportunity A ${ts}`;
    const oppB = `E2E Backlog Opportunity B ${ts}`;
    const solA = `E2E Backlog Solution A ${ts}`;
    const solB = `E2E Backlog Solution B ${ts}`;

    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await createOpportunityWithSolution(page, oppA, solA);
    await createOpportunityWithSolution(page, oppB, solB);

    // ── Solutions is its own destination in the navigation ─────────────────
    await page.getByRole("link", { name: "Solutions", exact: true }).first().click();
    await expect(page).toHaveURL(/\/solutions$/);
    await expect(page.getByRole("heading", { name: "Solutions", exact: true })).toBeVisible();

    // ── Both solutions share the Idea column, each linking to its parent ───
    const idea = column(page, "IDEA");
    await expect(idea.getByText(solA)).toBeVisible();
    await expect(idea.getByText(solB)).toBeVisible();
    await expect(idea.getByRole("link", { name: oppA, exact: true })).toHaveAttribute("href", /\/discovery\/[0-9a-f-]+$/);

    // ── Drag Idea -> Validated, persisted across reload ────────────────────
    const card = idea.locator("[data-slot=card]", { hasText: solA });
    const statusWrite = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        Boolean(response.request().headers()["next-action"]) &&
        new URL(response.url()).pathname === `${base}/solutions`
    );
    await dragTo(page, card.getByLabel("Drag to reorder"), column(page, "VALIDATED"));
    await expect(column(page, "VALIDATED").getByText(solA)).toBeVisible({ timeout: 10_000 });
    await expect(idea.getByText(solA)).not.toBeVisible();

    const response = await statusWrite;
    expect(response.ok()).toBe(true);
    await response.finished();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(column(page, "VALIDATED").getByText(solA)).toBeVisible();
    await expect(column(page, "IDEA").getByText(solB)).toBeVisible();
  });

  test("Discovery no longer groups by Opportunity and a legacy link lands on Solutions", async ({ page, base }) => {
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Group board by").click();
    await expect(page.getByRole("option", { name: "Opportunity", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.goto(`${base}/discovery?groupBy=opportunity`);
    await expect(page).toHaveURL(/\/solutions(\?|$)/);
    await expect(page.getByRole("heading", { name: "Solutions", exact: true })).toBeVisible();
  });

  test("New solution, the table view and group-by work from the backlog", async ({ page, base }) => {
    const ts = Date.now();
    const opp = `E2E Parent Opportunity ${ts}`;
    const otherOpp = `E2E Other Opportunity ${ts}`;
    const sol = `E2E Dialog Solution ${ts}`;

    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await createOpportunityFromBoard(page, opp);
    await createOpportunityFromBoard(page, otherOpp);

    // ── New solution: required parent picker, created under the chosen parent ─
    await page.goto(`${base}/solutions`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New Solution", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Title").fill(sol);
    await expect(dialog.getByRole("button", { name: "Add Solution" })).toBeDisabled(); // no parent yet
    await dialog.getByRole("combobox", { name: "Opportunity" }).click();
    await page.getByRole("option", { name: opp, exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Add Solution" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Add Solution" }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15_000 });
    await expect(column(page, "IDEA").getByText(sol)).toBeVisible({ timeout: 15_000 });
    await expect(column(page, "IDEA").getByRole("link", { name: opp, exact: true })).toBeVisible();

    // ── Table view: one row per solution, parent link, title opens the panel ─
    await page.getByRole("tab", { name: "Table" }).click();
    await expect(page).toHaveURL(/view=table/);
    const table = page.getByRole("table", { name: "Solution backlog" });
    const row = table.getByRole("row", { name: new RegExp(sol) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole("link", { name: opp, exact: true })).toHaveAttribute("href", /\/discovery\/[0-9a-f-]+$/);
    await expect(row.getByText("Idea", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: sol, exact: true }).click();
    await expect(page.locator("[data-slot=\"sheet-content\"]").getByText(sol).first()).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");

    // ── Group by Opportunity: one column per parent, read-only ───────────────
    await page.goto(`${base}/solutions?groupBy=opportunity`);
    await page.waitForLoadState("networkidle");
    const parentColumn = page.locator("[data-slot=\"solution-backlog-column\"]", { hasText: opp });
    await expect(parentColumn.getByText(sol)).toBeVisible();
    await expect(page.locator("[data-slot=\"solution-backlog-column\"]", { hasText: otherOpp })).toHaveCount(0); // no solutions, no column
    await expect(page.getByLabel("Drag to reorder")).toHaveCount(0);
    await expect(page.locator("[data-slot=\"solution-backlog-readonly-note\"]")).toContainText("read-only");

    // ── Group by Squad, via the toggle, keeps the card and persists in the URL ─
    await page.getByLabel("Group board by").click();
    await page.getByRole("option", { name: "Squad", exact: true }).click();
    await expect(page).toHaveURL(/groupBy=squad/);
    await expect(page.locator("[data-slot=\"solution-backlog-column\"]", { hasText: "No squad" }).getByText(sol)).toBeVisible();

    // ── Stale / unknown groupBy falls back to the Status board ───────────────
    await page.goto(`${base}/solutions?groupBy=field:00000000-0000-0000-0000-000000000000`);
    await page.waitForLoadState("networkidle");
    await expect(column(page, "IDEA").getByText(sol)).toBeVisible();
    await expect(page.getByLabel("Drag to reorder").first()).toBeVisible();
  });
});
