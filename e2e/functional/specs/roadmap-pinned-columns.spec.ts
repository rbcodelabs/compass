/**
 * Roadmap board dock (ADR "Pinned columns for board views", OPP-25, reworked to ONE dock with tabs).
 *
 * Journey, on the workspace roadmap at a desktop width:
 *   1. By default "Not scheduled" is the only pinned column: a dock OUTSIDE the horizontal scroller, collapsed to a
 *      slim tab rail (one tab).
 *   2. Open it and drag a card onto NOW; scroll the board right and drag another onto SHIPPED. The dock does not move
 *      with the scroller, so the drop target is reachable without a mid-drag scroll.
 *   3. Pin LATER: it joins the SAME dock as a second tab, becomes active and the dock stays the same width. Switch
 *      tabs, use the keyboard (arrows move focus, Enter activates), close the dock from the active tab and from the
 *      panel's collapse button, reorder tabs from the column menu, and drop a card onto a tab of the closed dock.
 *   4. Reorder scroller columns from the column menu (no drag needed).
 *   5. Save a view with a layout, clear the browser's own copy, reload: the view restores the layout (active tab and
 *      dock state included). Change the layout: the view shows as modified; "Save changes" stores it.
 *   6. A corrupt saved layout degrades to the default layout; a stale one keeps what still exists; the OLD per-column
 *      collapsed shape still loads.
 *   7. In swimlane mode Not scheduled stays docked (it cannot be unpinned there).
 *   8. Below md there is no dock and Not scheduled is the last column in the scroller.
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
const dock = (page: Page) => page.getByTestId("board-pinned-region");
const tabs = (page: Page) => dock(page).getByRole("tab");
const tab = (page: Page, title: string) => dock(page).getByRole("tab", { name: new RegExp(`^${title} \\(`) });
const panel = (page: Page) => dock(page).getByRole("tabpanel");
const tabTitles = async (page: Page) => (await tabs(page).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""))).map((l) => l.replace(/ \(\d+\)$/, ""));
const columnTitles = (root: Locator) => root.locator("section > header h3").allTextContents();
const dockWidth = async (page: Page) => (await dock(page).boundingBox())!.width;

async function shot(page: Page, name: string) {
  const dir = process.env.QA_SHOTS_DIR;
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`) });
}


test.describe("Roadmap board dock", () => {
  // QUARANTINE(prod-e2e): second drag to SHIPPED leaves cardTwo in unscheduled column in full prod suite (job 01M7C5MDZS5DWAS1BS9YAH2KA1). See e2e/functional/QUARANTINE.md.
  test.fixme("one dock with tabs: pin, switch, collapse, reorder, drag, and a saved view that restores the layout", async ({ page, base }) => {
    test.setTimeout(300_000);
    const pool = requireLocalE2eDatabase();
    const tag = randomUUID().slice(0, 8);
    const bugOne = `E2E Dock Bug One ${tag}`;
    const bugTwo = `E2E Dock Bug Two ${tag}`;
    const nowItem = `E2E Dock Now Item ${tag}`;
    const viewName = `E2E Dock Layout ${tag}`;
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

      // ── 1. Default layout: one pinned column, the dock collapsed to its tab rail ──
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");
      await expect(dock(page)).toBeVisible({ timeout: 30_000 });
      await expect(tabs(page)).toHaveCount(1);
      await expect(tab(page, "Not scheduled")).toHaveAttribute("aria-selected", "false");
      await expect(panel(page)).toHaveCount(0);
      await expect(scroller(page).getByRole("tab")).toHaveCount(0);
      const scrollerBox = (await scroller(page).boundingBox())!;
      const dockBox = (await dock(page).boundingBox())!;
      expect(dockBox.x, "the dock sits to the right of the scroller, not inside it").toBeGreaterThanOrEqual(scrollerBox.x + scrollerBox.width - 1);
      const collapsedWidth = dockBox.width;

      // ── 2. Open it; drag from it, with and without the board scrolled ────────
      await tab(page, "Not scheduled").click();
      await expect(tab(page, "Not scheduled")).toHaveAttribute("aria-selected", "true");
      const unscheduled = panel(page).getByTestId("roadmap-unscheduled-column");
      await expect(unscheduled).toBeVisible();
      const openWidth = await dockWidth(page);
      expect(openWidth).toBeGreaterThan(collapsedWidth + 200);
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
      expect(after.x, "scrolling the board does not move the dock").toBe(before.x);
      await dragTo(page, cardTwo.getByLabel("Drag to schedule"), page.locator("#roadmap-column-SHIPPED"));
      await expect(cardTwo).toHaveCount(0, { timeout: 15_000 });
      await expect(page.locator("#roadmap-column-SHIPPED").getByText(bugTwo).first()).toBeVisible({ timeout: 15_000 });
      await scroller(page).evaluate((el) => { el.scrollLeft = 0; });

      // ── 3. Pin a second column: ONE dock, two tabs, constant width ────────────
      await page.getByRole("button", { name: "Pin Later to the right" }).click();
      await expect(dock(page)).toHaveCount(1);
      expect(await tabTitles(page)).toEqual(["Later", "Not scheduled"]);
      await expect(tab(page, "Later")).toHaveAttribute("aria-selected", "true");
      await expect(panel(page).locator("#roadmap-column-LATER")).toBeVisible();
      await expect(scroller(page).locator("#roadmap-column-LATER")).toHaveCount(0);
      expect(Math.abs((await dockWidth(page)) - openWidth), "two pinned columns take no more room than one").toBeLessThanOrEqual(1);

      await tab(page, "Not scheduled").click();
      await expect(tab(page, "Not scheduled")).toHaveAttribute("aria-selected", "true");
      await expect(panel(page).getByTestId("roadmap-unscheduled-column")).toBeVisible();
      await expect(panel(page).locator("#roadmap-column-LATER")).toHaveCount(0);
      expect(Math.abs((await dockWidth(page)) - openWidth)).toBeLessThanOrEqual(1);

      // Keyboard: arrows move focus without switching; Enter activates.
      await tab(page, "Not scheduled").focus();
      await page.keyboard.press("ArrowUp");
      await expect(tab(page, "Later")).toBeFocused();
      await expect(panel(page).getByTestId("roadmap-unscheduled-column"), "moving focus does not switch the panel").toBeVisible();
      await page.keyboard.press("Enter");
      await expect(panel(page).locator("#roadmap-column-LATER")).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await expect(tab(page, "Not scheduled")).toBeFocused();

      // Close from the active tab, reopen; close from the panel's collapse button.
      await tab(page, "Later").click();
      await expect(panel(page)).toHaveCount(0);
      expect(await dockWidth(page), "a collapsed dock is just the tab rail").toBeLessThan(openWidth - 200);
      await tab(page, "Later").click();
      await expect(panel(page).locator("#roadmap-column-LATER")).toBeVisible();
      await panel(page).getByRole("button", { name: "Collapse Later" }).click();
      await expect(panel(page)).toHaveCount(0);
      await expect(tab(page, "Later"), "focus returns to the tab").toBeFocused();

      // A tab of the closed dock is a drop target: dropping the NOW card on Later moves it there.
      await expect(tab(page, "Later")).toHaveAccessibleName(/^Later \(1\)/);
      await dragTo(page, page.locator('[data-slot="card"]').filter({ hasText: nowItem }).first().getByLabel("Drag to reorder"), tab(page, "Later"));
      await expect(tab(page, "Later")).toHaveAccessibleName(/^Later \(2\)/, { timeout: 15_000 });
      // The click can land while the drop is still settling, so retry it until the panel shows the dropped card.
      await expect(async () => {
        if ((await panel(page).count()) === 0) await tab(page, "Later").click();
        await expect(panel(page).getByText(nowItem).first()).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 });

      // Tabs reorder from the column menu; the active tab stays active.
      await page.getByRole("button", { name: "Pin Next to the right" }).click();
      expect(await tabTitles(page)).toEqual(["Next", "Later", "Not scheduled"]);
      await panel(page).getByRole("button", { name: "Next column options" }).click();
      await page.getByRole("menuitem", { name: "Move right" }).click();
      await expect.poll(() => tabTitles(page)).toEqual(["Later", "Next", "Not scheduled"]);
      await expect(tab(page, "Next")).toHaveAttribute("aria-selected", "true");
      await panel(page).getByRole("button", { name: "Next column options" }).click();
      await page.getByRole("menuitem", { name: "Move left" }).click();
      await expect.poll(() => tabTitles(page)).toEqual(["Next", "Later", "Not scheduled"]);

      // Unpinning the active column returns it to the scroller and hands the panel to its neighbour.
      await panel(page).getByRole("button", { name: "Unpin Next" }).click();
      await expect(scroller(page).locator("#roadmap-column-NEXT")).toBeVisible();
      expect(await tabTitles(page)).toEqual(["Later", "Not scheduled"]);
      await expect(tab(page, "Later")).toHaveAttribute("aria-selected", "true");
      await panel(page).getByRole("button", { name: "Unpin Later" }).click();
      await expect(scroller(page).locator("#roadmap-column-LATER")).toBeVisible();
      expect(await tabTitles(page)).toEqual(["Not scheduled"]);

      // ── 4. Reorder scroller columns from the column menu ─────────────────────
      expect((await columnTitles(scroller(page))).slice(0, 3)).toEqual(["Now", "Next", "Later"]);
      await page.getByRole("button", { name: "Now column options" }).click();
      await expect(page.getByRole("menuitem", { name: "Move left" })).toHaveAttribute("aria-disabled", "true");
      await page.getByRole("menuitem", { name: "Move right" }).click();
      await expect.poll(async () => (await columnTitles(scroller(page))).slice(0, 3)).toEqual(["Next", "Now", "Later"]);

      // ── 5. Save a view with a layout; it restores the layout ─────────────────
      await page.getByRole("button", { name: "Pin Later to the right" }).click();
      await expect(panel(page).locator("#roadmap-column-LATER")).toBeVisible();
      await page.getByTestId("saved-views-trigger").click();
      await page.getByTestId("save-view-new").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill(viewName);
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 15_000 });
      await expect(page.getByTestId("saved-views-trigger")).toContainText(viewName);
      await expect(page).toHaveURL(/[?&]saved=[0-9a-f-]{36}/);
      expect(new URL(page.url()).search, "the layout is not a URL param").not.toMatch(/pinned|layout|columnOrder|dock/i);

      type StoredLayout = { pinnedColumnIds: string[]; columnOrder: string[]; activePinnedId?: string | null; dockCollapsed?: boolean };
      const { rows: viewRows } = await pool.query<{ id: string; display: { columnLayout?: StoredLayout } }>(
        `SELECT id, display FROM "${S}".roadmap_views WHERE workspace_id = $1 AND name = $2`,
        [workspaceId, viewName],
      );
      expect(viewRows).toHaveLength(1);
      const viewId = viewRows[0].id;
      const saved = viewRows[0].display.columnLayout!;
      expect(saved.pinnedColumnIds).toEqual(expect.arrayContaining(["LATER", "unscheduled"]));
      expect(saved.activePinnedId).toBe("LATER");
      expect(saved.dockCollapsed).toBe(false);
      expect(saved.columnOrder.slice(0, 3)).toEqual(["NEXT", "NOW", "LATER"]);

      // This browser's own copy would also restore the layout, so clear it: the VIEW must carry it.
      await page.evaluate(() => window.localStorage.clear());
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger")).toContainText(viewName, { timeout: 30_000 });
      await expect(tab(page, "Later")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      await expect(panel(page).locator("#roadmap-column-LATER")).toBeVisible();
      expect((await columnTitles(scroller(page))).slice(0, 2)).toEqual(["Next", "Now"]);

      // Not modified until the layout changes (switching the tab counts); then Save changes stores it.
      await expect(page.getByTestId("save-view-changes")).toHaveCount(0);
      await tab(page, "Not scheduled").click();
      await expect(page.getByTestId("save-view-changes")).toBeVisible();
      await panel(page).getByRole("button", { name: "Collapse Not scheduled" }).click();
      await tab(page, "Later").click();
      await panel(page).getByRole("button", { name: "Unpin Later" }).click();
      await expect(scroller(page).locator("#roadmap-column-LATER")).toBeVisible();
      await page.getByTestId("save-view-changes").click();
      await expect(page.getByTestId("save-view-changes")).toHaveCount(0, { timeout: 15_000 });
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger")).toContainText(viewName, { timeout: 30_000 });
      await expect(scroller(page).locator("#roadmap-column-LATER")).toBeVisible({ timeout: 30_000 });
      expect(await tabTitles(page)).toEqual(["Not scheduled"]);

      // ── 6. Corrupt, stale and older-shape stored layouts ─────────────────────
      await pool.query(`UPDATE "${S}".roadmap_views SET display = display || '{"columnLayout": "garbage"}'::jsonb WHERE id = $1`, [viewId]);
      await page.evaluate(() => window.localStorage.clear());
      await page.goto(`${base}/roadmap?saved=${viewId}`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger"), "the view itself still loads").toContainText(viewName, { timeout: 30_000 });
      await expect(tab(page, "Not scheduled"), "default layout: Not scheduled pinned, dock collapsed").toHaveAttribute("aria-selected", "false", { timeout: 30_000 });
      await expect(panel(page)).toHaveCount(0);
      expect((await columnTitles(scroller(page))).slice(0, 3)).toEqual(["Now", "Next", "Later"]);

      await pool.query(`UPDATE "${S}".roadmap_views SET display = display || '{"columnLayout": {"columnOrder": ["SHIPPED", "GONE"], "pinnedColumnIds": ["GONE", "NOW"], "activePinnedId": "GONE"}}'::jsonb WHERE id = $1`, [viewId]);
      await page.goto(`${base}/roadmap?saved=${viewId}`);
      await page.waitForLoadState("networkidle");
      await expect(tab(page, "Now"), "a stale layout keeps what still exists").toBeVisible({ timeout: 30_000 });
      expect(await tabTitles(page)).toEqual(["Now", "Not scheduled"]);
      expect((await columnTitles(scroller(page)))[0]).toBe("Shipped");

      await pool.query(
        `UPDATE "${S}".roadmap_views SET display = display || '{"columnLayout": {"columnOrder": ["NOW","NEXT","LATER","SHIPPED","unscheduled"], "pinnedColumnIds": ["unscheduled","LATER"], "collapsedColumnIds": ["LATER"]}}'::jsonb WHERE id = $1`,
        [viewId],
      );
      await page.goto(`${base}/roadmap?saved=${viewId}`);
      await page.waitForLoadState("networkidle");
      await expect(tab(page, "Later"), "an older per-column-collapsed layout still loads").toBeVisible({ timeout: 30_000 });
      expect(await tabTitles(page)).toEqual(["Later", "Not scheduled"]);
      await expect(panel(page), "and the dock starts collapsed").toHaveCount(0);

      // ── 7. Swimlane mode: Not scheduled stays docked (horizons live in the lane grid) ─
      await page.goto(`${base}/roadmap?groupBy=squad`);
      await page.waitForLoadState("networkidle");
      await expect(tab(page, "Not scheduled")).toBeVisible({ timeout: 30_000 });
      await tab(page, "Not scheduled").click();
      await expect(panel(page).getByTestId("roadmap-unscheduled-column")).toBeVisible();
      await expect(panel(page).getByRole("button", { name: "Collapse Not scheduled" })).toBeVisible();
      await expect(panel(page).getByRole("button", { name: "Unpin Not scheduled" }), "it cannot be unpinned while lanes are on").toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Pin .* to the right$/ })).toHaveCount(0);
      await page.evaluate(() => window.localStorage.clear());

      // ── 7b. Look: divider, 2rem taper, screenshots at 1280x800 ───────────────
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");
      await expect(dock(page)).toBeVisible({ timeout: 30_000 });
      expect(await dock(page).evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe("1px");
      const mask = await scroller(page).evaluate((el) => getComputedStyle(el).maskImage);
      expect(mask).toContain("linear-gradient");
      expect(mask, "the taper is 2rem (32px)").toMatch(/calc\(100% - 32px\)|calc\(-32px \+ 100%\)/);
      expect(await scroller(page).locator('[data-slot="roadmap-board-track"]').evaluate((el) => getComputedStyle(el).paddingRight), "track padding matches the taper").toBe("32px");
      const midScroll = () => scroller(page).evaluate((el) => { el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2; });
      await midScroll();
      await shot(page, "desktop-tabs-1-default-collapsed");
      await tab(page, "Not scheduled").click();
      await midScroll();
      await shot(page, "desktop-tabs-2-expanded");
      await page.getByRole("button", { name: "Pin Later to the right" }).click();
      await midScroll();
      await expect(tab(page, "Later")).toHaveAttribute("aria-selected", "true");
      await shot(page, "desktop-tabs-3-two-pinned-later-active");
      await tab(page, "Not scheduled").click();
      await midScroll();
      await shot(page, "desktop-tabs-4-two-pinned-not-scheduled-active");
      await scroller(page).evaluate((el) => { el.scrollLeft = el.scrollWidth; });
      await shot(page, "desktop-tabs-5-scrolled-to-end");
      const endGap = await scroller(page).evaluate((el) => {
        const cols = el.querySelectorAll("section");
        return el.getBoundingClientRect().right - cols[cols.length - 1].getBoundingClientRect().right;
      });
      expect(endGap, "the last column ends 2rem before the scroller's edge, outside the taper").toBeGreaterThanOrEqual(31);
      await page.evaluate(() => window.localStorage.clear());

      // ── 8. Narrow viewport: no dock, pinned columns are scroller columns ─────
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(dock(page)).toHaveCount(0);
      await expect(page.getByRole("tablist", { name: "Pinned columns" })).toHaveCount(0);
      await expect(scroller(page).getByTestId("roadmap-unscheduled-column")).toBeAttached();
      await expect(page.getByRole("button", { name: /^Pin .* to the right$/ })).toHaveCount(0);
      await shot(page, "desktop-tabs-6-narrow-390x844-fallback");
    } finally {
      await pool.query(`DELETE FROM "${S}".roadmap_views WHERE name = $1`, [viewName]);
      await pool.query(`DELETE FROM "${S}".roadmap_items WHERE title IN ($1, $2, $3)`, [nowItem, bugOne, bugTwo]);
      await pool.query(`DELETE FROM "${S}".feedback WHERE title IN ($1, $2)`, [bugOne, bugTwo]);
      await pool.end();
    }
  });
});
