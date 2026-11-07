/**
 * Roadmap board pinned columns (ADR "Pinned columns for board views", OPP-25).
 *
 * Journey, on the workspace roadmap at a desktop width:
 *   1. By default "Not scheduled" is an ordinary column pinned to the right, collapsed to a slim tab, in a
 *      region OUTSIDE the horizontal scroller.
 *   2. Expand it and drag a card onto NOW; scroll the board right and drag another onto SHIPPED. The pinned
 *      column does not move with the scroller, so the drop target is reachable without a mid-drag scroll.
 *   3. Pin LATER: it docks right next to Not scheduled, outside the scroller. Collapse it to a tab, expand it,
 *      unpin it. Pin and collapse are keyboard operable and keep focus on the control that replaces them.
 *   4. Reorder from the column menu (no drag needed).
 *   5. Save a view with a layout, clear the browser's own copy, reload: the view restores the layout. Change the
 *      layout: the view shows as modified; "Save changes" stores it.
 *   6. A corrupt saved layout degrades to the default layout; the view itself still loads.
 *   7. In swimlane mode Not scheduled stays docked (it cannot be unpinned there).
 *   8. Below md the pinned region disappears and Not scheduled is the last column in the scroller.
 *
 * Fixtures: two unscheduled Bug feedback items and one NOW roadmap item are inserted straight into the local
 * compass_e2e database (like roadmap-saved-views.spec.ts) and removed in `finally`, along with the views made here.
 * Set QA_SHOTS_DIR to also write screenshots of each state there.
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
    throw new Error("Pinned-column tests require the dedicated local compass_e2e database");
  }
  return new pg.Pool({ connectionString: url.toString() });
}

/** dnd-kit's PointerSensor needs real, stepped mouse movement; same approach as roadmap-unscheduled-items.spec.ts. */
async function dragTo(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error("drag source has no bounding box");
  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 15, startY + 15, { steps: 10 });
  const targetBox = await target.boundingBox();
  if (!targetBox) throw new Error("drag target has no bounding box");
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + Math.min(targetBox.height / 2, 120), { steps: 40 });
  await page.mouse.up();
}

const scroller = (page: Page) => page.getByRole("region", { name: "Roadmap board" });
const pinnedRegion = (page: Page) => page.getByTestId("board-pinned-region");
const columnTitles = (root: Locator) => root.locator("section > header h3").allTextContents();

async function shot(page: Page, name: string) {
  const dir = process.env.QA_SHOTS_DIR;
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

test.describe("Roadmap board pinned columns", () => {
  test("pin, collapse, reorder, drag from a pinned column, and a saved view that restores the layout", async ({ page, base }) => {
    test.setTimeout(240_000);
    const pool = requireLocalE2eDatabase();
    const tag = randomUUID().slice(0, 8);
    const bugOne = `E2E Pinned Bug One ${tag}`;
    const bugTwo = `E2E Pinned Bug Two ${tag}`;
    const nowItem = `E2E Pinned Now Item ${tag}`;
    const viewName = `E2E Pinned Layout ${tag}`;
    let workspaceId = "";

    try {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT w.id FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $1 AND w.slug = $2`,
        [ORG, WORKSPACE],
      );
      workspaceId = rows[0].id;
      for (const title of [bugOne, bugTwo]) {
        await pool.query(
          `INSERT INTO "${S}".feedback (id, workspace_id, title, type, status, vote_count, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'BUG', 'OPEN', 0, NOW(), NOW())`,
          [workspaceId, title],
        );
      }
      await pool.query(
        `INSERT INTO "${S}".roadmap_items (id, workspace_id, title, horizon, status, sort_order, now_commitment_provenance, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'NOW', 'ACTIVE', 0, 'LEGACY_UNGATED', NOW(), NOW())`,
        [workspaceId, nowItem],
      );

      await page.setViewportSize({ width: 1440, height: 900 });

      // ── 1. Default layout ────────────────────────────────────────────────────
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");
      const region = pinnedRegion(page);
      await expect(region).toBeVisible({ timeout: 30_000 });
      const expandTab = region.getByRole("button", { name: /^Expand Not scheduled/ });
      await expect(expandTab).toBeVisible();
      await expect(expandTab).toHaveAttribute("aria-expanded", "false");
      await expect(scroller(page).getByRole("button", { name: /^Expand Not scheduled/ })).toHaveCount(0);
      const scrollerBox = (await scroller(page).boundingBox())!;
      const regionBox = (await region.boundingBox())!;
      expect(regionBox.x, "the pinned region sits to the right of the scroller, not inside it").toBeGreaterThanOrEqual(scrollerBox.x + scrollerBox.width - 1);
      await shot(page, "01-default-not-scheduled-pinned-collapsed");

      // ── 2. Drag from the pinned column, with and without the board scrolled ──
      await expandTab.click();
      const unscheduled = region.getByTestId("roadmap-unscheduled-column");
      await expect(unscheduled).toBeVisible();
      await shot(page, "02-default-not-scheduled-pinned-expanded");
      const cardOne = unscheduled.locator('[data-slot="card"]').filter({ hasText: bugOne });
      const cardTwo = unscheduled.locator('[data-slot="card"]').filter({ hasText: bugTwo });
      await expect(cardOne).toBeVisible();
      await expect(cardTwo).toBeVisible();

      await dragTo(page, cardOne.getByLabel("Drag to schedule"), page.locator("#roadmap-column-NOW"));
      await expect(cardOne).toHaveCount(0, { timeout: 15_000 });
      await expect(page.locator("#roadmap-column-NOW").getByText(bugOne).first()).toBeVisible({ timeout: 15_000 });

      const before = (await unscheduled.boundingBox())!;
      await scroller(page).evaluate((el) => { el.scrollLeft = el.scrollWidth; });
      await expect.poll(() => scroller(page).evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
      const after = (await unscheduled.boundingBox())!;
      expect(after.x, "scrolling the board does not move the pinned column").toBe(before.x);
      await dragTo(page, cardTwo.getByLabel("Drag to schedule"), page.locator("#roadmap-column-SHIPPED"));
      await expect(cardTwo).toHaveCount(0, { timeout: 15_000 });
      await expect(page.locator("#roadmap-column-SHIPPED").getByText(bugTwo).first()).toBeVisible({ timeout: 15_000 });
      await scroller(page).evaluate((el) => { el.scrollLeft = 0; });

      // ── 3. Pin a second column; collapse / expand / unpin; keyboard ───────────
      await page.getByRole("button", { name: "Pin Later to the right" }).click();
      await expect(region.locator("#roadmap-column-LATER")).toBeVisible();
      await expect(scroller(page).locator("#roadmap-column-LATER")).toHaveCount(0);
      expect(await columnTitles(region)).toEqual(["Later", "Not scheduled"]);
      await shot(page, "03-two-pinned-columns");

      await region.getByRole("button", { name: "Collapse Later" }).click();
      const laterTab = region.getByRole("button", { name: /^Expand Later/ });
      await expect(laterTab).toBeVisible();
      await expect(laterTab).toHaveAttribute("aria-expanded", "false");
      await expect(laterTab, "focus follows the control that replaced the collapse button").toBeFocused();
      await shot(page, "04-collapsed-pinned-tab");
      await laterTab.click();
      await expect(region.locator("#roadmap-column-LATER")).toBeVisible();

      const unpin = region.getByRole("button", { name: "Unpin Later" });
      await unpin.focus();
      await page.keyboard.press("Enter");
      await expect(scroller(page).locator("#roadmap-column-LATER")).toBeVisible();
      await expect(page.getByRole("button", { name: "Pin Later to the right" })).toBeFocused();
      await page.keyboard.press("Space");
      await expect(region.locator("#roadmap-column-LATER")).toBeVisible();
      await region.getByRole("button", { name: "Unpin Later" }).click();
      await expect(scroller(page).locator("#roadmap-column-LATER")).toBeVisible();

      // ── 4. Reorder from the column menu ──────────────────────────────────────
      expect((await columnTitles(scroller(page))).slice(0, 3)).toEqual(["Now", "Next", "Later"]);
      await page.getByRole("button", { name: "Now column options" }).click();
      await expect(page.getByRole("menuitem", { name: "Move left" })).toHaveAttribute("aria-disabled", "true");
      await page.getByRole("menuitem", { name: "Move right" }).click();
      await expect.poll(async () => (await columnTitles(scroller(page))).slice(0, 3)).toEqual(["Next", "Now", "Later"]);

      // ── 5. Save a view with a layout; it restores the layout ─────────────────
      await page.getByRole("button", { name: "Pin Later to the right" }).click();
      await expect(region.locator("#roadmap-column-LATER")).toBeVisible();
      await page.getByTestId("saved-views-trigger").click();
      await page.getByTestId("save-view-new").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill(viewName);
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 15_000 });
      await expect(page.getByTestId("saved-views-trigger")).toContainText(viewName);
      await expect(page).toHaveURL(/[?&]saved=[0-9a-f-]{36}/);
      expect(new URL(page.url()).search, "the layout is not a URL param").not.toMatch(/pinned|layout|columnOrder/i);

      const { rows: viewRows } = await pool.query<{ id: string; display: { columnLayout?: { pinnedColumnIds: string[]; columnOrder: string[] } } }>(
        `SELECT id, display FROM "${S}".roadmap_views WHERE workspace_id = $1 AND name = $2`,
        [workspaceId, viewName],
      );
      expect(viewRows).toHaveLength(1);
      const viewId = viewRows[0].id;
      expect(viewRows[0].display.columnLayout?.pinnedColumnIds).toEqual(expect.arrayContaining(["LATER", "unscheduled"]));
      expect(viewRows[0].display.columnLayout?.columnOrder.slice(0, 3)).toEqual(["NEXT", "NOW", "LATER"]);

      // This browser's own copy would also restore the layout, so clear it: the VIEW must carry it.
      await page.evaluate(() => window.localStorage.clear());
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger")).toContainText(viewName, { timeout: 30_000 });
      await expect(pinnedRegion(page).locator("#roadmap-column-LATER")).toBeVisible({ timeout: 30_000 });
      expect((await columnTitles(scroller(page))).slice(0, 2)).toEqual(["Next", "Now"]);

      // Not modified until the layout changes; then Save changes stores it.
      await expect(page.getByTestId("save-view-changes")).toHaveCount(0);
      await pinnedRegion(page).getByRole("button", { name: "Unpin Later" }).click();
      await expect(scroller(page).locator("#roadmap-column-LATER")).toBeVisible();
      await expect(page.getByTestId("save-view-changes")).toBeVisible();
      await page.getByTestId("save-view-changes").click();
      await expect(page.getByTestId("save-view-changes")).toHaveCount(0, { timeout: 15_000 });
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger")).toContainText(viewName, { timeout: 30_000 });
      await expect(scroller(page).locator("#roadmap-column-LATER")).toBeVisible({ timeout: 30_000 });
      await expect(pinnedRegion(page).locator("#roadmap-column-LATER")).toHaveCount(0);

      // ── 6. A corrupt saved layout degrades to the default layout ─────────────
      await pool.query(`UPDATE "${S}".roadmap_views SET display = display || '{"columnLayout": "garbage"}'::jsonb WHERE id = $1`, [viewId]);
      await page.evaluate(() => window.localStorage.clear());
      await page.goto(`${base}/roadmap?saved=${viewId}`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger"), "the view itself still loads").toContainText(viewName, { timeout: 30_000 });
      await expect(pinnedRegion(page).getByRole("button", { name: /^Expand Not scheduled/ }), "default layout: Not scheduled pinned and collapsed").toBeVisible({ timeout: 30_000 });
      expect((await columnTitles(scroller(page))).slice(0, 3)).toEqual(["Now", "Next", "Later"]);
      await pool.query(`UPDATE "${S}".roadmap_views SET display = display || '{"columnLayout": {"columnOrder": ["SHIPPED", "GONE"], "pinnedColumnIds": ["GONE", "NOW"]}}'::jsonb WHERE id = $1`, [viewId]);
      await page.goto(`${base}/roadmap?saved=${viewId}`);
      await page.waitForLoadState("networkidle");
      await expect(pinnedRegion(page).locator("#roadmap-column-NOW"), "a stale layout keeps what still exists").toBeVisible({ timeout: 30_000 });
      expect((await columnTitles(scroller(page)))[0]).toBe("Shipped");

      // ── 7. Swimlane mode: Not scheduled stays docked (horizons live in the lane grid) ─────
      await page.goto(`${base}/roadmap?groupBy=squad`);
      await page.waitForLoadState("networkidle");
      const laneTab = pinnedRegion(page).getByRole("button", { name: /^Expand Not scheduled/ });
      await expect(laneTab).toBeVisible({ timeout: 30_000 });
      await laneTab.click();
      const laneRegion = pinnedRegion(page);
      await expect(laneRegion.getByTestId("roadmap-unscheduled-column")).toBeVisible();
      await expect(laneRegion.getByRole("button", { name: "Collapse Not scheduled" })).toBeVisible();
      await expect(laneRegion.getByRole("button", { name: "Unpin Not scheduled" }), "it cannot be unpinned while lanes are on").toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Pin .* to the right$/ })).toHaveCount(0);
      await shot(page, "05-swimlane-mode-not-scheduled-docked");
      await page.evaluate(() => window.localStorage.clear());

      // ── 8. Narrow viewport: pinned columns fall back to scroller columns ──────
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");
      await page.setViewportSize({ width: 600, height: 900 });
      await expect(pinnedRegion(page)).toHaveCount(0);
      await expect(scroller(page).getByTestId("roadmap-unscheduled-column")).toBeAttached();
      await expect(page.getByRole("button", { name: /^Pin .* to the right$/ })).toHaveCount(0);
      await shot(page, "06-narrow-viewport-fallback");
    } finally {
      await pool.query(`DELETE FROM "${S}".roadmap_views WHERE name = $1`, [viewName]);
      await pool.query(`DELETE FROM "${S}".roadmap_items WHERE title IN ($1, $2, $3)`, [nowItem, bugOne, bugTwo]);
      await pool.query(`DELETE FROM "${S}".feedback WHERE title IN ($1, $2)`, [bugOne, bugTwo]);
      await pool.end();
    }
  });
});
