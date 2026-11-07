/**
 * Opportunities (Discovery) status board dock (Compass TASK-109, PR 3 of the consistent pinned/tabbed dock program).
 *
 * The Opportunity board, grouped by status, uses the same ONE-dock-with-tabs as the roadmap and Solutions boards:
 *   1. Nothing is pinned by default: no dock, the Active-first order (Active, Prioritized, Validating, Exploring).
 *   2. Pin VALIDATING, then ACTIVE: one dock, two tabs (column order), constant width; switch tabs.
 *   3. Drag and drop with the dock: drop an Exploring card on a dock TAB (it registers under the column's own
 *      `column-<status>` droppable id), drag a card out of the docked panel into a scroller column, and the IN-COLUMN
 *      ORDERING that opportunity cards also have still works, both in a scroller column and inside the docked panel, and the
 *      new order survives a reload (the column is renumbered, so gapped and tied stored orders cannot undo it). Hovering a
 *      card over a tab whose column is not open must not move the card until it is dropped.
 *   4. The Columns popover keeps hide/show but reorders the SAME layout the column menu moves.
 *   5. Save a view: the layout is stored as `display.columnLayout` and restores after a reload with this browser's own copy
 *      cleared; changing the layout marks the view Modified; Reset restores the saved layout.
 *   6. A corrupt stored layout degrades to the defaults; a view saved before layouts existed (only `columns.status.order`)
 *      still loads in that order and is not Modified.
 *   7. The "Group by <custom field>" board ignores pinning: no dock, no pin controls.
 *   8. Below md there is no dock; pinned columns are ordinary scroller columns.
 *
 * Fixtures (Opportunities, a custom field and the saved views) go straight into the local compass_e2e database and are
 * removed in `finally`. Set QA_SHOTS_DIR to also write screenshots there.
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
    throw new Error("Discovery dock tests require the dedicated local compass_e2e database");
  }
  return new pg.Pool({ connectionString: url.toString() });
}

/**
 * dnd-kit's PointerSensor needs real, stepped mouse movement. With `alignCard` (the dragged card, when `source` is just its
 * handle) the pointer is placed so the dragged CARD's centre lands on the target's centre: closestCenter measures the card,
 * and the handle sits at the card's left edge. Tabs are found by pointer position instead (pointerWithin), so they are
 * targeted with the plain pointer.
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

const scroller = (page: Page) => page.getByRole("region", { name: "Opportunity board" });
const dock = (page: Page) => page.getByTestId("board-pinned-region");
const tabs = (page: Page) => dock(page).getByRole("tab");
const tab = (page: Page, title: string) => dock(page).getByRole("tab", { name: new RegExp(`^${title} \\(`) });
const panel = (page: Page) => dock(page).getByRole("tabpanel");
const tabTitles = async (page: Page) => (await tabs(page).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""))).map((l) => l.replace(/ \(\d+\)$/, ""));
const tabCount = async (page: Page, title: string) => Number(/\((\d+)\)$/.exec((await tab(page, title).getAttribute("aria-label")) ?? "")?.[1]);
const columnTitles = (root: Locator) => root.locator("section > header h3").allTextContents();
const dockWidth = async (page: Page) => (await dock(page).boundingBox())!.width;
const column = (page: Page, status: string) => page.locator(`[data-slot='opportunity-board-column'][data-status='${status}']`);
const cardOf = (root: Locator, title: string) => root.locator("[data-flip-id]", { hasText: title });
/** The order the given titles appear in within a column, top to bottom. */
const orderIn = async (root: Locator, titles: string[]) => {
  const all = await root.locator("[data-flip-id]").allInnerTexts();
  return titles.sort((a, b) => all.findIndex((t) => t.includes(a)) - all.findIndex((t) => t.includes(b)));
};

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

test.describe("Opportunity board dock", () => {
  test("pin, tabs, drag and drop and in-column ordering, Columns popover, saved view, legacy view, field board and narrow screens", async ({ page, base }) => {
    test.setTimeout(480_000);
    const pageErrors = capturePageErrors(page);
    const pool = requireLocalE2eDatabase();
    const tag = randomUUID().slice(0, 8);
    const titles = {
      exploringOne: `E2E Dock Exploring One ${tag}`,
      exploringTwo: `E2E Dock Exploring Two ${tag}`,
      toTab: `E2E Dock To Tab ${tag}`,
      validating: `E2E Dock Validating ${tag}`,
      activeOne: `E2E Dock Active One ${tag}`,
      activeTwo: `E2E Dock Active Two ${tag}`,
      prioritizedOne: `E2E Dock Prioritized One ${tag}`,
      prioritizedTwo: `E2E Dock Prioritized Two ${tag}`,
      validatingOne: `E2E Dock Validating One ${tag}`,
      validatingTwo: `E2E Dock Validating Two ${tag}`,
    };
    const viewName = `E2E Opportunities Dock ${tag}`;
    const legacyName = `E2E Legacy Opp Order ${tag}`;
    const fieldName = `E2E Dock Field ${tag}`;
    let workspaceId = "";
    let organizationId = "";
    let fieldId = "";
    const rowOf = async (title: string) =>
      (await pool.query<{ status: string; sort_order: number }>(`SELECT status, sort_order FROM "${S}".opportunities WHERE title = $1`, [title])).rows[0];
    const statusOf = async (title: string) => (await rowOf(title))?.status;
    /**
     * Drags `second` (listed second) onto `first` inside `root`, then checks the order three ways: on screen at once, in the
     * database (the column is renumbered, so the two are distinct and in the new order), and after a reload. `dockTab` re-opens
     * the docked panel (a reload restores the dock but the active tab is whatever was last open).
     */
    const reorderAndReload = async (root: Locator, first: string, second: string, dockTab?: string) => {
      expect(await orderIn(root, [first, second]), "starts in seeded order").toEqual([first, second]);
      const secondCard = cardOf(root, second);
      await dragTo(page, secondCard.getByLabel("Drag to reorder"), cardOf(root, first), { alignCard: secondCard });
      await expect.poll(async () => (await rowOf(second)).sort_order < (await rowOf(first)).sort_order, { timeout: 15_000 }).toBe(true);
      expect((await rowOf(second)).status, "a reorder never changes the status").toBe((await rowOf(first)).status);
      await page.reload();
      await page.waitForLoadState("networkidle");
      if (dockTab) {
        await expect(tab(page, dockTab)).toBeVisible({ timeout: 30_000 });
        if ((await tab(page, dockTab).getAttribute("aria-selected")) !== "true") await tab(page, dockTab).click();
      }
      await expect(cardOf(root, second)).toBeVisible({ timeout: 30_000 });
      expect(await orderIn(root, [first, second]), "the new order is what the server persisted").toEqual([second, first]);
    };

    try {
      const { rows } = await pool.query<{ id: string; organization_id: string }>(
        `SELECT w.id, w.organization_id FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $1 AND w.slug = $2`,
        [ORG, WORKSPACE],
      );
      workspaceId = rows[0].id;
      organizationId = rows[0].organization_id;
      // Two stored-order shapes, so a reorder is proven against both: DENSE non-negative (0, 1) in the Exploring scroller
      // column and the Validating docked panel, and GAPPED negative (-5000, -4999) in the Prioritized scroller column and
      // the Active docked panel (the old single-index write could not hold that shape).
      const seed: [string, string, number][] = [
        [titles.exploringOne, "EXPLORING", 0],
        [titles.exploringTwo, "EXPLORING", 1],
        [titles.toTab, "EXPLORING", 2],
        [titles.validating, "VALIDATING", -6000],
        [titles.validatingOne, "VALIDATING", 0],
        [titles.validatingTwo, "VALIDATING", 1],
        [titles.activeOne, "ACTIVE", -5000],
        [titles.activeTwo, "ACTIVE", -4999],
        [titles.prioritizedOne, "PRIORITIZED", -3000],
        [titles.prioritizedTwo, "PRIORITIZED", -2999],
      ];
      for (const [title, status, sortOrder] of seed) {
        await pool.query(
          `INSERT INTO "${S}".opportunities (id, workspace_id, title, status, sort_order, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW())`,
          [workspaceId, title, status, sortOrder],
        );
      }
      const { rows: field } = await pool.query<{ id: string }>(
        `INSERT INTO "${S}".custom_field_definitions (id, workspace_id, object_type, name, field_type, options, required, "order", created_at)
         VALUES (gen_random_uuid(), $1, 'OPPORTUNITY', $2, 'SELECT', $3::jsonb, false, 0, NOW()) RETURNING id`,
        [workspaceId, fieldName, JSON.stringify([{ label: "Must", value: "must" }, { label: "Should", value: "should" }])],
      );
      fieldId = field[0].id;

      await page.setViewportSize({ width: 1440, height: 900 });

      // ── 1. Default: nothing pinned, no dock, Active-first order ─────────────
      await page.goto(`${base}/discovery`);
      await page.evaluate(() => window.localStorage.clear());
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(column(page, "EXPLORING").getByText(titles.exploringOne)).toBeVisible({ timeout: 30_000 });
      await expect(dock(page)).toHaveCount(0);
      expect(await columnTitles(scroller(page))).toEqual(["Active", "Prioritized", "Validating", "Exploring"]);
      await expect(page.getByRole("button", { name: "Pin Exploring to the right" })).toBeAttached();
      await shot(page, "desktop-1-default");

      // ── 2. Pin VALIDATING, then ACTIVE: one dock, two tabs, constant width ──
      await page.getByRole("button", { name: "Pin Validating to the right" }).click();
      await expect(dock(page)).toHaveCount(1);
      expect(await tabTitles(page)).toEqual(["Validating"]);
      await expect(tab(page, "Validating")).toHaveAttribute("aria-selected", "true");
      await expect(panel(page).getByText(titles.validating)).toBeVisible();
      await expect(scroller(page).locator("[data-status=VALIDATING]")).toHaveCount(0);
      const scrollerBox = (await scroller(page).boundingBox())!;
      const dockBox = (await dock(page).boundingBox())!;
      expect(dockBox.x, "the dock sits right of the scroller, not inside it").toBeGreaterThanOrEqual(scrollerBox.x + scrollerBox.width - 1);
      const openWidth = dockBox.width;
      await shot(page, "desktop-2-one-pinned-validating");

      await page.getByRole("button", { name: "Pin Active to the right" }).click();
      await expect(dock(page)).toHaveCount(1);
      expect(await tabTitles(page), "tabs follow column order").toEqual(["Active", "Validating"]);
      await expect(tab(page, "Active")).toHaveAttribute("aria-selected", "true");
      await expect(panel(page).getByText(titles.activeOne)).toBeVisible();
      expect(Math.abs((await dockWidth(page)) - openWidth), "two pinned columns take no more room than one").toBeLessThanOrEqual(1);
      await tab(page, "Validating").click();
      await expect(panel(page).getByText(titles.validating)).toBeVisible();
      await expect(panel(page).getByText(titles.activeOne)).toHaveCount(0);
      expect(await columnTitles(scroller(page))).toEqual(["Prioritized", "Exploring"]);
      await shot(page, "desktop-3-two-pinned-tab-switch");

      // ── 3. Drag and drop with the dock ───────────────────────────────────────
      // 3-pre. Hovering a card over a tab whose column is NOT the open panel must not move it into that (unrendered) column:
      // the destination is resolved when the card is dropped. (Moving it mid-drag unmounts the dragged card; that is what
      // threw "Maximum update depth".) On the way to the tab the pointer crosses the open panel, so the card may be shown in
      // THAT column meanwhile; what matters is that the card is still mounted (the drag overlay's copy plus the card itself: 2, where an
      // unmounted dragged card would leave 1), the Active count is unchanged, and
      // cancelling the drag with Escape puts it back where it started and writes nothing.
      {
        const activeCount = await tabCount(page, "Active");
        const handle = cardOf(column(page, "EXPLORING"), titles.exploringOne).getByLabel("Drag to reorder");
        const box = (await handle.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + 15, box.y + 15, { steps: 10 });
        const tabBox = (await tab(page, "Active").boundingBox())!;
        await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2, { steps: 30 });
        await page.waitForTimeout(600);
        await expect(page.locator("[data-flip-id]", { hasText: titles.exploringOne }), "the dragged card stays mounted (card + drag overlay)").toHaveCount(2);
        expect(await tabCount(page, "Active"), "hovering a tab moves nothing into its column").toBe(activeCount);
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await expect(cardOf(column(page, "EXPLORING"), titles.exploringOne), "a cancelled drag puts the card back").toHaveCount(1);
        expect(await tabCount(page, "Active")).toBe(activeCount);
        expect(await statusOf(titles.exploringOne), "a cancelled drag writes nothing").toBe("EXPLORING");
      }

      // 3a. Active panel is Validating; drop an Exploring card on the ACTIVE tab (a drop target registered as column-ACTIVE).
      const activeBefore = await tabCount(page, "Active");
      await dragTo(page, cardOf(column(page, "EXPLORING"), titles.toTab).getByLabel("Drag to reorder"), tab(page, "Active"));
      await expect.poll(() => tabCount(page, "Active"), { timeout: 15_000 }).toBe(activeBefore + 1);
      await expect.poll(() => statusOf(titles.toTab), { timeout: 15_000 }).toBe("ACTIVE");
      // The status write revalidates and remounts the board; reload so the next drag starts on a settled page. This also shows
      // this browser remembered the layout (two tabs, Validating active) with no saved view.
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(tab(page, "Validating")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      expect(await tabTitles(page)).toEqual(["Active", "Validating"]);

      // 3b. The docked panel's cards drag out to a scroller column.
      await expect(panel(page).getByText(titles.validating)).toBeVisible();
      const validatingCard = cardOf(panel(page), titles.validating);
      await dragTo(page, validatingCard.getByLabel("Drag to reorder"), column(page, "EXPLORING"), { alignCard: validatingCard });
      await expect(column(page, "EXPLORING").getByText(titles.validating)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => statusOf(titles.validating), { timeout: 15_000 }).toBe("EXPLORING");
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(tab(page, "Validating")).toBeVisible({ timeout: 30_000 });

      // 3c. In-column ORDERING still works in a scroller column, and the new order survives a reload.
      // Dense stored order (0, 1): Exploring Two onto Exploring One.
      await reorderAndReload(column(page, "EXPLORING"), titles.exploringOne, titles.exploringTwo);
      // Gapped stored order (-3000, -2999): Prioritized Two onto Prioritized One.
      await reorderAndReload(column(page, "PRIORITIZED"), titles.prioritizedOne, titles.prioritizedTwo);

      // 3d. ...and inside the docked panel (the open panel is a sortable drop target too), for both stored-order shapes.
      await tab(page, "Active").click();
      await expect(panel(page).getByText(titles.activeOne)).toBeVisible();
      await reorderAndReload(panel(page), titles.activeOne, titles.activeTwo, "Active");
      await tab(page, "Validating").click();
      await expect(panel(page).getByText(titles.validatingOne)).toBeVisible();
      await reorderAndReload(panel(page), titles.validatingOne, titles.validatingTwo, "Validating");
      await tab(page, "Active").click();
      await expect(tab(page, "Active")).toHaveAttribute("aria-selected", "true");

      // ── 4. Collapse, and the Columns popover shares the layout's order ───────
      await panel(page).getByRole("button", { name: "Collapse Active" }).click();
      await expect(panel(page)).toHaveCount(0);
      await expect(tab(page, "Active")).toBeFocused();
      await shot(page, "desktop-4-dock-collapsed");
      await page.getByTestId("columns-trigger").click();
      const rowOrder = () => page.locator("[data-testid^=columns-row-]").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.replace("columns-row-", "")));
      expect(await rowOrder()).toEqual(["ACTIVE", "PRIORITIZED", "VALIDATING", "EXPLORING"]);
      await page.getByLabel("Move Exploring up").click();
      await expect.poll(rowOrder).toEqual(["ACTIVE", "PRIORITIZED", "EXPLORING", "VALIDATING"]);
      expect(new URL(page.url()).search, "reordering writes the layout, not the URL").not.toMatch(/order=/);
      await page.keyboard.press("Escape");
      expect(await columnTitles(scroller(page))).toEqual(["Prioritized", "Exploring"]);
      // The column menu moves the same order, and the popover sees it.
      await page.getByRole("button", { name: "Exploring column options" }).click();
      await page.getByRole("menuitem", { name: "Move left" }).click();
      await expect.poll(async () => await columnTitles(scroller(page))).toEqual(["Exploring", "Prioritized"]);
      await page.getByTestId("columns-trigger").click();
      await expect.poll(rowOrder).toEqual(["ACTIVE", "EXPLORING", "PRIORITIZED", "VALIDATING"]);
      await page.keyboard.press("Escape");
      await tab(page, "Active").click();
      await expect(tab(page, "Active")).toHaveAttribute("aria-selected", "true");

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
      const { rows: viewRows } = await pool.query<{ id: string; display: { columnLayout?: StoredLayout; columns?: { status?: { order: string[] } } } }>(
        `SELECT id, display FROM "${S}".roadmap_views WHERE workspace_id = $1 AND name = $2 AND surface = 'OPPORTUNITIES_BOARD'`,
        [workspaceId, viewName],
      );
      expect(viewRows).toHaveLength(1);
      const viewId = viewRows[0].id;
      const savedLayout = viewRows[0].display.columnLayout!;
      expect(savedLayout.pinnedColumnIds).toEqual(expect.arrayContaining(["ACTIVE", "VALIDATING"]));
      expect(savedLayout.activePinnedId).toBe("ACTIVE");
      expect(savedLayout.dockCollapsed).toBe(false);
      expect(savedLayout.columnOrder).toEqual(["ACTIVE", "EXPLORING", "PRIORITIZED", "VALIDATING"]);
      expect(viewRows[0].display.columns?.status?.order ?? [], "the layout is the one source of order: no second legacy order").toEqual([]);

      // This browser's own copy would also restore the layout, so clear it: the VIEW must carry it.
      await page.evaluate(() => window.localStorage.clear());
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger")).toContainText(viewName, { timeout: 30_000 });
      await expect(tab(page, "Active")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      expect(await tabTitles(page)).toEqual(["Active", "Validating"]);
      expect(await columnTitles(scroller(page))).toEqual(["Exploring", "Prioritized"]);
      await expect(page.getByTestId("saved-view-modified")).toHaveCount(0);
      await expect(page.getByTestId("save-view-changes")).toHaveCount(0);

      // Changing the layout (the active tab counts) marks the view Modified; Reset restores the saved layout.
      await tab(page, "Validating").click();
      await expect(page.getByTestId("saved-view-modified")).toBeVisible();
      await expect(page.getByTestId("save-view-changes")).toBeVisible();
      await page.getByTestId("reset-view").click();
      await expect(page.getByTestId("saved-view-modified")).toHaveCount(0, { timeout: 15_000 });
      await expect(tab(page, "Active")).toHaveAttribute("aria-selected", "true");
      // Reset also navigates (a bare ?saved= that the server expands back to edited=1) and the page remounts when that lands,
      // so let the round trip settle before editing again (an edit made mid-flight would be discarded by the remount).
      await expect(page).toHaveURL(/edited=1/, { timeout: 15_000 });
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(3_000);
      await expect(tab(page, "Active")).toHaveAttribute("aria-selected", "true");

      // Edit and "Save changes": unpin Validating, store, reload.
      await tab(page, "Validating").click();
      await panel(page).getByRole("button", { name: "Unpin Validating" }).click();
      await expect(page.getByTestId("save-view-changes")).toBeVisible();
      await page.getByTestId("save-view-changes").click();
      await expect(page.getByTestId("save-view-changes")).toHaveCount(0, { timeout: 15_000 });
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger")).toContainText(viewName, { timeout: 30_000 });
      expect(await tabTitles(page)).toEqual(["Active"]);

      // ── 6a. Corrupt stored layout degrades to the defaults; the view still loads ─
      await pool.query(`UPDATE "${S}".roadmap_views SET display = display || '{"columnLayout": "garbage"}'::jsonb WHERE id = $1`, [viewId]);
      await page.evaluate(() => window.localStorage.clear());
      await page.goto(`${base}/discovery?saved=${viewId}`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger"), "the view itself still loads").toContainText(viewName, { timeout: 30_000 });
      await expect(dock(page)).toHaveCount(0);
      expect(await columnTitles(scroller(page))).toEqual(["Active", "Prioritized", "Validating", "Exploring"]);

      // ── 6b. A view saved before layouts existed (only columns.status.order) still loads, unmodified ─
      const { rows: legacy } = await pool.query<{ id: string }>(
        `INSERT INTO "${S}".roadmap_views (id, organization_id, workspace_id, owner_id, name, visibility, surface, filters, display, created_at, updated_at)
         SELECT gen_random_uuid(), $1, $2, owner_id, $3, 'PERSONAL', 'OPPORTUNITIES_BOARD', '{"squadIds": []}'::jsonb,
                '{"view":"board","groupBy":"status","sort":"manual","columns":{"status":{"order":["EXPLORING","ACTIVE","PRIORITIZED","VALIDATING"],"hidden":[]}}}'::jsonb, NOW(), NOW()
         FROM "${S}".roadmap_views WHERE id = $4 RETURNING id`,
        [organizationId, workspaceId, legacyName, viewId],
      );
      await page.evaluate(() => window.localStorage.clear());
      await page.goto(`${base}/discovery?saved=${legacy[0].id}`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger")).toContainText(legacyName, { timeout: 30_000 });
      await expect.poll(async () => (await columnTitles(scroller(page))).slice(0, 2), { timeout: 30_000 }).toEqual(["Exploring", "Active"]);
      await expect(page.getByTestId("saved-view-modified"), "an untouched legacy view is not Modified").toHaveCount(0);
      await expect(dock(page)).toHaveCount(0);
      // Pinning on top of it works and now counts as a change.
      await page.getByRole("button", { name: "Pin Validating to the right" }).click();
      await expect(page.getByTestId("saved-view-modified")).toBeVisible();
      // The legacy ?order= link still reads, too.
      await page.evaluate(() => window.localStorage.clear());
      await page.goto(`${base}/discovery?order=EXPLORING,VALIDATING`);
      await page.waitForLoadState("networkidle");
      await expect.poll(async () => (await columnTitles(scroller(page))).slice(0, 2), { timeout: 30_000 }).toEqual(["Exploring", "Validating"]);

      // ── 7. The custom-field board ignores pinning ────────────────────────────
      await page.evaluate(() => window.localStorage.clear());
      await page.goto(`${base}/discovery`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "Pin Exploring to the right" }).click();
      await expect(dock(page)).toHaveCount(1);
      await page.goto(`${base}/discovery?groupBy=field:${fieldId}`);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("[data-column-id=unspecified]")).toBeVisible({ timeout: 30_000 });
      await expect(dock(page)).toHaveCount(0);
      await expect(page.getByRole("tablist", { name: "Pinned columns" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Pin .* to the right$/ })).toHaveCount(0);
      await expect(page.getByTestId("board-column-menu")).toHaveCount(0);
      await expect(page.getByTestId("columns-trigger"), "the Columns popover is a status-board control").toHaveCount(0);
      await shot(page, "desktop-5-field-board-ignores-pinning");

      // ── 8. Look at 1280x800, then below md: no dock, pinned columns in the scroller ─
      await page.goto(`${base}/discovery`);
      await page.waitForLoadState("networkidle");
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(dock(page)).toBeVisible({ timeout: 30_000 });
      await shot(page, "desktop-6-1280x800-pinned-persisted");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(dock(page)).toHaveCount(0);
      await expect(page.getByRole("tablist", { name: "Pinned columns" })).toHaveCount(0);
      await expect(scroller(page).locator("[data-status=EXPLORING]")).toBeAttached();
      await expect(page.getByRole("button", { name: /^Pin .* to the right$/ })).toHaveCount(0);
      await shot(page, "narrow-390x844-no-dock-fallback");
      expect(pageErrors, "no uncaught page errors during the journey").toEqual([]);
    } finally {
      await pool.query(`DELETE FROM "${S}".roadmap_views WHERE name = ANY($1)`, [[viewName, legacyName]]);
      await pool.query(`DELETE FROM "${S}".opportunities WHERE title = ANY($1)`, [Object.values(titles)]);
      if (fieldId) await pool.query(`DELETE FROM "${S}".custom_field_definitions WHERE id = $1`, [fieldId]);
      await pool.end();
    }
  });
});
