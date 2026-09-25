/**
 * Discovery "Group by: Opportunity" swimlane functional spec.
 *
 * Solutions — the middle tier of the Opportunity Solution Tree — have no
 * board of their own; this mode adds one, as a mode of the existing
 * Discovery tab: one collapsible lane per Opportunity, 5 Solution-status
 * columns inside each.
 *
 * Journey:
 *   1. Create an Opportunity and a Solution on it, switch into "Group by:
 *      Opportunity", confirm the lane and the solution render.
 *   2. Drag the Solution card into a different status column *within its own
 *      lane* — confirm it lands there and survives a reload (status +
 *      sortOrder persisted via the new moveSolutionStatus action).
 *   3. Create a second Opportunity and drag a Solution from lane A into lane
 *      B's column of the same status label — confirm it snaps back to lane A
 *      with no persisted change after reload. Cross-lane re-parenting is a
 *      deliberate panel action, never a side effect of a board drag.
 *
 * dnd-kit's PointerSensor needs real mouse movement (not a single jump) to
 * activate past its 8px activation-distance threshold, so drags here are
 * simulated with page.mouse.move/down/up rather than Playwright's built-in
 * dragTo — same approach as e2e/functional/specs/roadmap-unscheduled-items.spec.ts.
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
  // Small initial move past dnd-kit's PointerSensor activation distance (8px).
  await page.mouse.move(startX + 15, startY + 15, { steps: 10 });

  await target.scrollIntoViewIfNeeded();
  const targetBox = await target.boundingBox();
  if (!targetBox) throw new Error("drag target has no bounding box");
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height / 2;

  await page.mouse.move(endX, endY, { steps: 20 });
  await page.mouse.up();
}

async function groupBoardBy(page: Page, grouping: string) {
  await page.getByLabel("Group board by").click();
  await page.getByRole("option", { name: grouping, exact: true }).click();
}

async function createOpportunity(page: Page, title: string) {
  await createOpportunityFromBoard(page, title);
  await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible({ timeout: 15_000 });
}

async function addSolutionViaPanel(page: Page, opportunityTitle: string, solutionTitle: string) {
  await page.getByRole("button", { name: opportunityTitle, exact: true }).click();
  const panel = page.locator('[data-slot="sheet-content"]');
  await panel.getByRole("button", { name: "Add Solution" }).click();
  await panel.getByLabel("Title").fill(solutionTitle);
  await panel.getByRole("button", { name: "Add Solution" }).click();
  await expect(panel.getByText(solutionTitle)).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  // Confirm the panel actually closed rather than racing ahead — under load,
  // a single Escape keypress can land before the dialog's listener is ready.
  await expect(panel).not.toBeVisible({ timeout: 10_000 });
}

function laneFor(page: Page, opportunityTitle: string) {
  return page.locator("[data-slot='collapsible']", {
    has: page.getByRole("button", { name: new RegExp(opportunityTitle) }),
  });
}

// Targets the column's own data-slot rather than its tag. The previous version
// matched `section`, which only worked while a lane column was a BoardColumn;
// lane columns are now purpose-built (the lane is the only filled surface), so
// a tag-based locator silently matched nothing. Still scoped by the visible
// status heading so this keeps asserting the label renders.
function columnFor(lane: Locator, statusLabel: string) {
  return lane.locator("[data-slot='swimlane-column']", {
    has: lane.page().getByRole("heading", { name: statusLabel }),
  });
}

test.describe("Discovery swimlane (group by Opportunity)", () => {
  test("switches into Opportunity grouping and persists a same-lane status drag", async ({ page, base }) => {
    const ts = Date.now();
    const opportunityTitle = `E2E Swimlane Opportunity ${ts}`;
    const solutionTitle = `E2E Swimlane Solution ${ts}`;

    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");

    await createOpportunity(page, opportunityTitle);
    await addSolutionViaPanel(page, opportunityTitle, solutionTitle);

    // ── Switch into "Group by: Opportunity" ────────────────────────────────
    await expect(page.getByLabel("Group board by")).toContainText("Status");
    await groupBoardBy(page, "Opportunity");
    await expect(page).toHaveURL(/groupBy=opportunity/);
    await expect(page.getByLabel("Group board by")).toContainText("Opportunity");

    const lane = laneFor(page, opportunityTitle);
    await expect(lane).toBeVisible();
    await expect(lane.getByText(solutionTitle)).toBeVisible();
    await expect(lane.getByRole("heading", { name: "Idea" })).toBeVisible();
    await expect(lane.getByRole("heading", { name: "Validated" })).toBeVisible();

    // ── Same-lane drag: Idea -> Validated ──────────────────────────────────
    const solutionCard = lane.locator("[data-slot=card]", { hasText: solutionTitle });
    const dragHandle = solutionCard.getByLabel("Drag to reorder");
    const ideaColumn = columnFor(lane, "Idea");
    const validatedColumn = columnFor(lane, "Validated");

    await expect(ideaColumn.getByText(solutionTitle)).toBeVisible();
    const statusWrite = page.waitForResponse(response =>
      response.request().method() === "POST" &&
      Boolean(response.request().headers()["next-action"]) &&
      new URL(response.url()).pathname === `${base}/discovery`
    );
    await dragTo(page, dragHandle, validatedColumn);
    await expect(validatedColumn.getByText(solutionTitle)).toBeVisible({ timeout: 10_000 });
    await expect(ideaColumn.getByText(solutionTitle)).not.toBeVisible();

    // Persisted — reload and confirm the status change survived.
    const response = await statusWrite;
    expect(response.ok()).toBe(true);
    await response.finished();
    await page.reload();
    await page.waitForLoadState("networkidle");
    const laneAfterReload = laneFor(page, opportunityTitle);
    const validatedColumnAfterReload = columnFor(laneAfterReload, "Validated");
    await expect(validatedColumnAfterReload.getByText(solutionTitle)).toBeVisible();
  });

  test("dragging a solution card into a different lane reverts with no persisted change", async ({ page, base }) => {
    const ts = Date.now();
    const opportunityATitle = `E2E Swimlane Lane A ${ts}`;
    const opportunityBTitle = `E2E Swimlane Lane B ${ts}`;
    const solutionTitle = `E2E Swimlane Cross-lane Solution ${ts}`;

    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");

    await createOpportunity(page, opportunityATitle);
    await createOpportunity(page, opportunityBTitle);
    await addSolutionViaPanel(page, opportunityATitle, solutionTitle);

    await groupBoardBy(page, "Opportunity");
    await expect(page).toHaveURL(/groupBy=opportunity/);

    const laneA = laneFor(page, opportunityATitle);
    const laneB = laneFor(page, opportunityBTitle);
    await expect(laneA).toBeVisible();
    await expect(laneB).toBeVisible();

    const solutionCard = laneA.locator("[data-slot=card]", { hasText: solutionTitle });
    const dragHandle = solutionCard.getByLabel("Drag to reorder");
    const laneAIdeaColumn = columnFor(laneA, "Idea");
    const laneBIdeaColumn = columnFor(laneB, "Idea");

    await expect(laneAIdeaColumn.getByText(solutionTitle)).toBeVisible();
    await dragTo(page, dragHandle, laneBIdeaColumn);

    // Snapped back — never landed in lane B, still in lane A's Idea column.
    await expect(laneBIdeaColumn.getByText(solutionTitle)).not.toBeVisible();
    await expect(laneAIdeaColumn.getByText(solutionTitle)).toBeVisible();

    await page.reload();
    await page.waitForLoadState("networkidle");
    const laneAAfterReload = laneFor(page, opportunityATitle);
    const laneBAfterReload = laneFor(page, opportunityBTitle);
    await expect(columnFor(laneAAfterReload, "Idea").getByText(solutionTitle)).toBeVisible();
    await expect(columnFor(laneBAfterReload, "Idea").getByText(solutionTitle)).not.toBeVisible();
  });
});
