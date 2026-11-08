/**
 * Solutions status board dock (Compass TASK-108, PR 2 of the consistent pinned/tabbed dock program).
 *
 * The Solutions backlog, grouped by status, uses the same ONE-dock-with-tabs as the roadmap board:
 *   1. Nothing is pinned by default: no dock, the active-work-first order (In delivery, Validated, Idea, Shipped, Killed).
 *   2. Pin SHIPPED: it moves into a dock outside the scroller and opens. Pin KILLED: a second tab in the SAME dock.
 *      Switch tabs; the dock is the same width with one pinned column or two.
 *   3. Board drag and drop still works with a dock: drop an Idea card on a dock TAB (it registers under the column's own
 *      `column-<status>` droppable id, so it lands in that status) and drag a card out of the docked panel into a scroller column.
 *   4. The Columns popover keeps hide/show but reorders the SAME layout the column menu moves.
 *   5. Save a view: the layout is stored as `display.columnLayout` and restores after a reload with this browser's own copy
 *      cleared; changing the layout marks the view Modified; Reset restores the saved layout.
 *   6. A corrupt stored layout degrades to the defaults; a view saved before layouts existed (only `columns.status.order`)
 *      still loads in that order and is not Modified.
 *   7. A grouped board (opportunity) ignores pinning: no dock, no pin controls.
 *   8. Below md there is no dock; pinned columns are ordinary scroller columns.
 * and the roadmap's grouping control is an icon-only trigger with a tooltip and an active dot.
 *
 * Fixtures (an Opportunity and four Solutions, and the saved views) go straight into the local compass_e2e database and
 * are removed in `finally`. Set QA_SHOTS_DIR to also write screenshots there.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";

function requireLocalE2eDatabase(): pg.Pool {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") {
    throw new Error("Solutions dock tests require the dedicated local compass_e2e database");
  }
  return new pg.Pool({ connectionString: url.toString() });
}

/**
 * dnd-kit's PointerSensor needs real, stepped mouse movement. With `alignCard` (the dragged card, when `source` is just its handle) the pointer is placed so the dragged
 * CARD's centre (not the pointer) lands on the target's centre: closestCenter measures the card, and the handle sits at the
 * card's left edge, so aiming the pointer at a column's centre would otherwise pick the neighbouring column. Tabs are
 * found by pointer position instead (pointerWithin), so they are targeted with the plain pointer. The pointer goes to the target's vertical centre too: a column's droppable is its tall body, and a point near its top is closer to a neighbouring column's cards.
 */
async function dragTo(page: Page, source: Locator, target: Locator, { alignCard }: { alignCard?: Locator } = {}) {
  await source.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error("drag source has no bounding box");
  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 15, startY + 15, { steps: 10 });
  await target.waitFor({ state: "visible", timeout: 10_000 });
  const targetBox = await target.boundingBox();
  if (!targetBox) throw new Error("drag target has no bounding box");
  const cardBox = alignCard ? await alignCard.boundingBox() : null;
  const cardCentreOffset = cardBox ? startX - (cardBox.x + cardBox.width / 2) : 0;
  await page.mouse.move(targetBox.x + targetBox.width / 2 + cardCentreOffset, targetBox.y + targetBox.height / 2, { steps: 40 });
  await page.mouse.up();
}

const scroller = (page: Page) => page.getByRole("region", { name: "Solution backlog" });
const dock = (page: Page) => page.getByTestId("board-pinned-region");
const tabs = (page: Page) => dock(page).getByRole("tab");
const tab = (page: Page, title: string) => dock(page).getByRole("tab", { name: new RegExp(`^${title} \\(`) });
const panel = (page: Page) => dock(page).getByRole("tabpanel");
const tabTitles = async (page: Page) => (await tabs(page).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""))).map((l) => l.replace(/ \(\d+\)$/, ""));
const columnTitles = (root: Locator) => root.locator("section > header h3").allTextContents();
const dockWidth = async (page: Page) => (await dock(page).boundingBox())!.width;
const column = (page: Page, status: string) => page.locator(`[data-slot='solution-backlog-column'][data-status='${status}']`);

/**
 * Collects uncaught page errors and prints each one's full stack to the test output (an error such as React's
 * "Maximum update depth exceeded" is otherwise only a line in the browser console). The journey asserts none occurred.
 */
function capturePageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.log(`[pageerror] ${error.message}\n${error.stack ?? "(no stack)"}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error" && /Maximum update depth/.test(message.text())) console.log(`[console.error] ${message.text()}`);
  });
  return errors;
}

async function shot(page: Page, name: string, { resize = true } = {}) {
  const dir = process.env.QA_SHOTS_DIR;
  if (!dir) return;
  // Desktop shots are taken at 1280x800 whatever the journey runs at; the narrow one keeps its own size.
  const before = page.viewportSize();
  const doResize = resize && before !== null && before.width >= 1000 && before.width !== 1280;
  if (doResize) { await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(400); }
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
  if (doResize && before) await page.setViewportSize(before);
}

test.describe("Solutions board dock", () => {
  test("pin, tabs, drag and drop, Columns popover, saved view, legacy view, grouped board and narrow screens", async ({ page, base }) => {
    test.setTimeout(420_000);
    const pageErrors = capturePageErrors(page);
    const pool = requireLocalE2eDatabase();
    const tag = randomUUID().slice(0, 8);
    const opportunity = `E2E Dock Opportunity ${tag}`;
    const ideaOne = `E2E Dock Idea One ${tag}`;
    const ideaTwo = `E2E Dock Idea Two ${tag}`;
    const shipped = `E2E Dock Shipped ${tag}`;
    const killed = `E2E Dock Killed ${tag}`;
    const viewName = `E2E Solutions Dock ${tag}`;
    const legacyName = `E2E Legacy Order ${tag}`;
    let workspaceId = "";
    let organizationId = "";
    const statusOf = async (title: string) => (await pool.query<{ status: string }>(`SELECT status FROM "${S}".solutions WHERE title = $1`, [title])).rows[0]?.status;

    try {
      const { rows } = await pool.query<{ id: string; organization_id: string }>(
        `SELECT w.id, w.organization_id FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $1 AND w.slug = $2`,
        [ORG, WORKSPACE],
      );
      workspaceId = rows[0].id;
      organizationId = rows[0].organization_id;
      const { rows: opp } = await pool.query<{ id: string }>(
        `INSERT INTO "${S}".opportunities (id, workspace_id, title, sort_order) VALUES (gen_random_uuid(), $1, $2, -5000) RETURNING id`,
        [workspaceId, opportunity],
      );
      for (const [index, [title, status]] of ([[ideaOne, "IDEA"], [ideaTwo, "IDEA"], [shipped, "SHIPPED"], [killed, "KILLED"]] as const).entries()) {
        await pool.query(
          `INSERT INTO "${S}".solutions (id, workspace_id, opportunity_id, title, status, sort_order) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
          [workspaceId, opp[0].id, title, status, -5000 + index],
        );
      }

      await page.setViewportSize({ width: 1440, height: 900 });

      // ── 1. Default: nothing pinned, no dock, active-work-first order ─────────
      await page.goto(`${base}/solutions`);
      await page.evaluate(() => window.localStorage.clear());
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(column(page, "IDEA").getByText(ideaOne)).toBeVisible({ timeout: 30_000 });
      await expect(dock(page)).toHaveCount(0);
      expect(await columnTitles(scroller(page))).toEqual(["In delivery", "Validated", "Idea", "Shipped", "Killed"]);
      await expect(page.getByRole("button", { name: "Pin Shipped to the right" })).toBeAttached();
      await shot(page, "desktop-1-default");

      // ── 2. Pin SHIPPED, then KILLED: one dock, two tabs, constant width ──────
      await page.getByRole("button", { name: "Pin Shipped to the right" }).click();
      await expect(dock(page)).toHaveCount(1);
      expect(await tabTitles(page)).toEqual(["Shipped"]);
      await expect(tab(page, "Shipped")).toHaveAttribute("aria-selected", "true");
      await expect(panel(page).getByText(shipped)).toBeVisible();
      await expect(scroller(page).locator("[data-status=SHIPPED]")).toHaveCount(0);
      const scrollerBox = (await scroller(page).boundingBox())!;
      const dockBox = (await dock(page).boundingBox())!;
      expect(dockBox.x, "the dock sits right of the scroller, not inside it").toBeGreaterThanOrEqual(scrollerBox.x + scrollerBox.width - 1);
      const openWidth = dockBox.width;
      await shot(page, "desktop-2-one-pinned-shipped");

      await page.getByRole("button", { name: "Pin Killed to the right" }).click();
      await expect(dock(page)).toHaveCount(1);
      expect(await tabTitles(page)).toEqual(["Shipped", "Killed"]);
      await expect(tab(page, "Killed")).toHaveAttribute("aria-selected", "true");
      await expect(panel(page).getByText(killed)).toBeVisible();
      expect(Math.abs((await dockWidth(page)) - openWidth), "two pinned columns take no more room than one").toBeLessThanOrEqual(1);
      await tab(page, "Shipped").click();
      await expect(panel(page).getByText(shipped)).toBeVisible();
      await expect(panel(page).getByText(killed)).toHaveCount(0);
      expect(await columnTitles(scroller(page))).toEqual(["In delivery", "Validated", "Idea"]);
      await shot(page, "desktop-3-two-pinned-tab-switch");

      // ── 3. Drag and drop with the dock ───────────────────────────────────────
      // 3a. Active panel is Shipped; drop an Idea card on the KILLED tab (a drop target registered as column-KILLED).
      await expect(tab(page, "Killed")).toHaveAccessibleName(/^Killed \(1\)/);
      await dragTo(page, column(page, "IDEA").locator("[data-slot=card]", { hasText: ideaOne }).getByLabel("Drag to reorder"), tab(page, "Killed"));
      await expect(tab(page, "Killed")).toHaveAccessibleName(/^Killed \(2\)/, { timeout: 15_000 });
      await expect.poll(() => statusOf(ideaOne), { timeout: 15_000 }).toBe("KILLED");
      // The status write revalidates and remounts the board; reload so the next drag starts on a settled page. This also shows
      // this browser remembered the layout (two tabs, Shipped active) with no saved view.
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(tab(page, "Shipped")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      expect(await tabTitles(page)).toEqual(["Shipped", "Killed"]);
      // 3b. The docked panel's cards drag out to a scroller column.
      await expect(panel(page).getByText(shipped)).toBeVisible();
      const shippedCard = panel(page).locator("[data-slot=card]", { hasText: shipped });
      await dragTo(page, shippedCard.getByLabel("Drag to reorder"), column(page, "VALIDATED"), { alignCard: shippedCard });
      await expect(column(page, "VALIDATED").getByText(shipped)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => statusOf(shipped), { timeout: 15_000 }).toBe("VALIDATED");
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(tab(page, "Shipped")).toBeVisible({ timeout: 30_000 });
      // 3c. And into the open panel's own column (the panel is a drop target too): Idea Two -> Killed (the open panel after a tab click).
      await tab(page, "Killed").click();
      await expect(panel(page).getByText(killed)).toBeVisible();
      const ideaTwoCard = column(page, "IDEA").locator("[data-slot=card]", { hasText: ideaTwo });
      await dragTo(page, ideaTwoCard.getByLabel("Drag to reorder"), panel(page), { alignCard: ideaTwoCard });
      await expect(panel(page).getByText(ideaTwo)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => statusOf(ideaTwo), { timeout: 15_000 }).toBe("KILLED");

      // ── 4. Collapse, and the Columns popover shares the layout's order ───────
      await panel(page).getByRole("button", { name: "Collapse Killed" }).click();
      await expect(panel(page)).toHaveCount(0);
      await expect(tab(page, "Killed")).toBeFocused();
      await shot(page, "desktop-4-dock-collapsed");
      await page.getByTestId("columns-trigger").click();
      const rowOrder = () => page.locator("[data-testid^=columns-row-]").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.replace("columns-row-", "")));
      expect(await rowOrder()).toEqual(["IN_DELIVERY", "VALIDATED", "IDEA", "SHIPPED", "KILLED"]);
      await page.getByLabel("Move Idea up").click();
      await expect.poll(rowOrder).toEqual(["IN_DELIVERY", "IDEA", "VALIDATED", "SHIPPED", "KILLED"]);
      expect(new URL(page.url()).search, "reordering writes the layout, not the URL").not.toMatch(/order=/);
      await page.keyboard.press("Escape");
      expect((await columnTitles(scroller(page))).slice(0, 3)).toEqual(["In delivery", "Idea", "Validated"]);
      // The column menu moves the same order, and the popover sees it.
      await page.getByRole("button", { name: "Idea column options" }).click();
      await page.getByRole("menuitem", { name: "Move right" }).click();
      await expect.poll(async () => (await columnTitles(scroller(page))).slice(0, 3)).toEqual(["In delivery", "Validated", "Idea"]);
      await tab(page, "Shipped").click();
      await expect(tab(page, "Shipped")).toHaveAttribute("aria-selected", "true");

      // ── 5. Save a view: the layout is stored, restores, and drives Modified ──
      await page.getByTestId("saved-views-trigger").click();
      await page.getByTestId("save-view-new").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill(viewName);
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 15_000 });
      await expect(page.getByTestId("saved-views-trigger")).toContainText(viewName);
      expect(new URL(page.url()).search, "the layout is not a URL param").not.toMatch(/pinned|layout|columnOrder|dock/i);

      type StoredLayout = { pinnedColumnIds: string[]; columnOrder: string[]; activePinnedId?: string | null; dockCollapsed?: boolean };
      const { rows: viewRows } = await pool.query<{ id: string; display: { columnLayout?: StoredLayout; columns?: unknown } }>(
        `SELECT id, display FROM "${S}".roadmap_views WHERE workspace_id = $1 AND name = $2`,
        [workspaceId, viewName],
      );
      expect(viewRows).toHaveLength(1);
      const viewId = viewRows[0].id;
      const savedLayout = viewRows[0].display.columnLayout!;
      expect(savedLayout.pinnedColumnIds).toEqual(expect.arrayContaining(["SHIPPED", "KILLED"]));
      expect(savedLayout.activePinnedId).toBe("SHIPPED");
      expect(savedLayout.dockCollapsed).toBe(false);
      expect(savedLayout.columnOrder.slice(0, 3)).toEqual(["IN_DELIVERY", "VALIDATED", "IDEA"]);

      // This browser's own copy would also restore the layout, so clear it: the VIEW must carry it.
      await page.evaluate(() => window.localStorage.clear());
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger")).toContainText(viewName, { timeout: 30_000 });
      await expect(tab(page, "Shipped")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      expect(await tabTitles(page)).toEqual(["Shipped", "Killed"]);
      await expect(page.getByTestId("saved-view-modified")).toHaveCount(0);
      await expect(page.getByTestId("save-view-changes")).toHaveCount(0);

      // Changing the layout (the active tab counts) marks the view Modified; Reset restores the saved layout.
      await tab(page, "Killed").click();
      await expect(page.getByTestId("saved-view-modified")).toBeVisible();
      await expect(page.getByTestId("save-view-changes")).toBeVisible();
      await page.getByTestId("reset-view").click();
      await expect(page.getByTestId("saved-view-modified")).toHaveCount(0, { timeout: 15_000 });
      await expect(tab(page, "Shipped")).toHaveAttribute("aria-selected", "true");
      // Reset also navigates (a bare ?saved= that the server expands back to edited=1) and the page remounts when that lands,
      // so let the round trip settle before editing again (an edit made mid-flight would be discarded by the remount).
      await expect(page).toHaveURL(/edited=1/, { timeout: 15_000 });
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(3_000);
      await expect(tab(page, "Shipped")).toHaveAttribute("aria-selected", "true");

      // Edit and "Save changes": unpin Killed, store, reload.
      await tab(page, "Killed").click();
      await panel(page).getByRole("button", { name: "Unpin Killed" }).click();
      await expect(page.getByTestId("save-view-changes")).toBeVisible();
      await page.getByTestId("save-view-changes").click();
      await expect(page.getByTestId("save-view-changes")).toHaveCount(0, { timeout: 15_000 });
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger")).toContainText(viewName, { timeout: 30_000 });
      expect(await tabTitles(page)).toEqual(["Shipped"]);

      // ── 6a. Corrupt stored layout degrades to the defaults; the view still loads ─
      await pool.query(`UPDATE "${S}".roadmap_views SET display = display || '{"columnLayout": "garbage"}'::jsonb WHERE id = $1`, [viewId]);
      await page.evaluate(() => window.localStorage.clear());
      await page.goto(`${base}/solutions?saved=${viewId}`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger"), "the view itself still loads").toContainText(viewName, { timeout: 30_000 });
      await expect(dock(page)).toHaveCount(0);
      expect(await columnTitles(scroller(page))).toEqual(["In delivery", "Validated", "Idea", "Shipped", "Killed"]);

      // ── 6b. A view saved before layouts existed (only columns.status.order) still loads, unmodified ─
      const { rows: legacy } = await pool.query<{ id: string }>(
        `INSERT INTO "${S}".roadmap_views (id, organization_id, workspace_id, owner_id, name, visibility, surface, filters, display, created_at, updated_at)
         SELECT gen_random_uuid(), $1, $2, owner_id, $3, 'PERSONAL', 'SOLUTIONS_BOARD', '{"squadIds": []}'::jsonb,
                '{"view":"board","groupBy":"status","sort":"manual","columns":{"status":{"order":["KILLED","IDEA","IN_DELIVERY","VALIDATED","SHIPPED"],"hidden":[]}}}'::jsonb, NOW(), NOW()
         FROM "${S}".roadmap_views WHERE id = $4 RETURNING id`,
        [organizationId, workspaceId, legacyName, viewId],
      );
      await page.evaluate(() => window.localStorage.clear());
      await page.goto(`${base}/solutions?saved=${legacy[0].id}`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger")).toContainText(legacyName, { timeout: 30_000 });
      await expect.poll(async () => (await columnTitles(scroller(page))).slice(0, 3), { timeout: 30_000 }).toEqual(["Killed", "Idea", "In delivery"]);
      await expect(page.getByTestId("saved-view-modified"), "an untouched legacy view is not Modified").toHaveCount(0);
      await expect(dock(page)).toHaveCount(0);
      // Pinning on top of it works and now counts as a change.
      await page.getByRole("button", { name: "Pin Shipped to the right" }).click();
      await expect(page.getByTestId("saved-view-modified")).toBeVisible();

      // ── 7. A grouped board ignores pinning ───────────────────────────────────
      await page.evaluate(() => window.localStorage.clear());
      await page.goto(`${base}/solutions`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "Pin Shipped to the right" }).click();
      await expect(dock(page)).toHaveCount(1);
      await page.goto(`${base}/solutions?groupBy=opportunity`);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("[data-slot=solution-backlog-column]", { hasText: opportunity })).toBeVisible({ timeout: 30_000 });
      await expect(dock(page)).toHaveCount(0);
      await expect(page.getByRole("tablist", { name: "Pinned columns" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Pin .* to the right$/ })).toHaveCount(0);
      await expect(page.getByTestId("board-column-menu")).toHaveCount(0);
      await expect(page.getByTestId("columns-trigger"), "the Columns popover is a status-board control").toHaveCount(0);
      await shot(page, "desktop-5-grouped-ignores-pinning");

      // ── 8. Look at 1280x800, then below md: no dock, pinned columns in the scroller ─
      await page.goto(`${base}/solutions`);
      await page.waitForLoadState("networkidle");
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(dock(page)).toBeVisible({ timeout: 30_000 });
      await shot(page, "desktop-6-1280x800-pinned-persisted");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(dock(page)).toHaveCount(0);
      await expect(page.getByRole("tablist", { name: "Pinned columns" })).toHaveCount(0);
      await expect(scroller(page).locator("[data-status=SHIPPED]")).toBeAttached();
      await expect(page.getByRole("button", { name: /^Pin .* to the right$/ })).toHaveCount(0);
      await shot(page, "narrow-390x844-no-dock-fallback");
      expect(pageErrors, "no uncaught page errors during the journey").toEqual([]);
    } finally {
      await pool.query(`DELETE FROM "${S}".roadmap_views WHERE name = ANY($1)`, [[viewName, legacyName]]);
      await pool.query(`DELETE FROM "${S}".solutions WHERE title = ANY($1)`, [[ideaOne, ideaTwo, shipped, killed]]);
      await pool.query(`DELETE FROM "${S}".opportunities WHERE title = $1`, [opportunity]);
      await pool.end();
    }
  });
});

test.describe("Roadmap grouping control", () => {
  test("is icon-only with a tooltip and an active dot, and still changes the grouping", async ({ page, base }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/roadmap`);
    await page.waitForLoadState("networkidle");

    const trigger = page.getByLabel("Group board by");
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    expect((await trigger.innerText()).trim(), "no visible text on the trigger").toBe("");
    expect((await trigger.boundingBox())!.width, "a compact, icon-sized trigger").toBeLessThan(48);
    await expect(page.getByTestId("group-by-active-dot")).toHaveCount(0);

    await trigger.hover();
    await expect(page.locator("[data-slot=tooltip-content]").filter({ hasText: "No swimlanes" })).toBeVisible({ timeout: 10_000 });
    await shot(page, "toggle-1-icon-only-tooltip", { resize: false });

    await trigger.click();
    await expect(page.getByRole("option", { name: "No swimlanes" })).toBeVisible();
    await shot(page, "toggle-2-open", { resize: false });
    await page.getByRole("option", { name: "Squad", exact: true }).click();
    await expect(page).toHaveURL(/groupBy=squad/);
    await expect(page.getByTestId("group-by-active-dot")).toBeVisible();
    await trigger.hover();
    await expect(page.locator("[data-slot=tooltip-content]").filter({ hasText: "Swimlanes: Squad" })).toBeVisible({ timeout: 10_000 });
    await shot(page, "toggle-3-squad-active-dot-tooltip", { resize: false });

    await trigger.click();
    await page.getByRole("option", { name: "No swimlanes" }).click();
    await expect(page).not.toHaveURL(/groupBy=/);
    await expect(page.getByTestId("group-by-active-dot")).toHaveCount(0);
  });
});
