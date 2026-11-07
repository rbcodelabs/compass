/**
 * Tasks board dock and saved views (Compass TASK-110, PR 4 of the consistent pinned/tabbed dock program).
 *
 * The Tasks board uses the same ONE-dock-with-tabs as the roadmap, Solutions and Opportunity boards, and gets saved views
 * of its own (surface TASKS_BOARD) so the layout follows you across devices:
 *   1. Nothing is pinned by default: no dock, the workflow order (Backlog ... Done).
 *   2. Pin DONE, then BLOCKED: one dock, two tabs, the dock keeps its width; switch tabs.
 *   3. Drag a task onto a dock TAB (it registers under the column's own `column-<status>` droppable id) and out of the docked
 *      panel into a scroller column; add a task from the docked panel's footer; in-column reorder still works in the
 *      scroller and in the open panel.
 *   4. "Show cancelled" changes the column set: a pinned CANCELLED appears and disappears from the dock with the toggle.
 *   5. Below md there is no dock; pinned columns are ordinary scroller columns.
 *   6. Save a Tasks view with a filter and a layout: it is stored under TASKS_BOARD, and `?saved=<id>` restores both with this
 *      browser's own copy cleared. A layout change or a filter edit marks it Modified; Reset restores it; delete removes it.
 *   7. A corrupt stored layout degrades to the defaults while the view's filters still apply.
 *
 * Fixtures (tasks and the saved views) go straight into the local compass_e2e database and are removed in `finally`.
 * Set QA_SHOTS_DIR to also write screenshots there.
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
    throw new Error("Tasks dock tests require the dedicated local compass_e2e database");
  }
  return new pg.Pool({ connectionString: url.toString() });
}

/** See solutions-board-dock.spec.ts: stepped real mouse movement; `alignCard` aims the dragged CARD's centre at the target. */
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

const scroller = (page: Page) => page.getByRole("region", { name: "Task board" });
const dock = (page: Page) => page.getByTestId("board-pinned-region");
const tabs = (page: Page) => dock(page).getByRole("tab");
const tab = (page: Page, title: string) => dock(page).getByRole("tab", { name: new RegExp(`^${title} \\(`) });
const panel = (page: Page) => dock(page).getByRole("tabpanel");
const tabTitles = async (page: Page) => (await tabs(page).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""))).map((l) => l.replace(/ \(\d+\)$/, ""));
const columnTitles = (root: Locator) => root.locator("section > header h3").allTextContents();
const dockWidth = async (page: Page) => (await dock(page).boundingBox())!.width;
const column = (page: Page, status: string) => page.locator(`[data-task-column='${status}']`);
const cardOf = (root: Locator, title: string) => root.locator("[data-slot=card]", { hasText: title });

async function shot(page: Page, name: string, { resize = true } = {}) {
  const dir = process.env.QA_SHOTS_DIR;
  if (!dir) return;
  const before = page.viewportSize();
  const doResize = resize && before !== null && before.width >= 1000 && before.width !== 1280;
  if (doResize) { await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(400); }
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
  if (doResize && before) await page.setViewportSize(before);
}

async function workspaceIds(pool: pg.Pool) {
  const { rows } = await pool.query<{ id: string; organization_id: string }>(
    `SELECT w.id, w.organization_id FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $1 AND w.slug = $2`,
    [ORG, WORKSPACE],
  );
  return { workspaceId: rows[0].id, organizationId: rows[0].organization_id };
}

async function insertTask(pool: pg.Pool, workspaceId: string, title: string, status: string, sortOrder: number, priority = "MEDIUM") {
  await pool.query(
    `INSERT INTO "${S}".tasks (id, workspace_id, title, status, priority, sort_order) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [workspaceId, title, status, priority, sortOrder],
  );
}

test.describe("Tasks board dock", () => {
  test("pin, tabs, drag and drop, add from the panel, reorder, show cancelled and narrow screens", async ({ page, base }) => {
    test.setTimeout(420_000);
    const pool = requireLocalE2eDatabase();
    const tag = randomUUID().slice(0, 8);
    const t = (name: string) => `E2E Dock ${name} ${tag}`;
    const [a1, a2, a3, d1, d2, d3, blocked, cancelled, added] = ["A1", "A2", "A3", "D1", "D2", "D3", "Blocked", "Cancelled", "Added"].map(t);
    const statusOf = async (title: string) => (await pool.query<{ status: string }>(`SELECT status FROM "${S}".tasks WHERE title = $1`, [title])).rows[0]?.status;

    try {
      const { workspaceId } = await workspaceIds(pool);
      for (const [title, status, order] of [[a1, "TODO", -5000], [a2, "TODO", -4999], [a3, "TODO", -4998], [d1, "DONE", -5000], [d2, "DONE", -4999], [d3, "DONE", -4998], [blocked, "BLOCKED", -5000], [cancelled, "CANCELLED", -5000]] as const) {
        await insertTask(pool, workspaceId, title, status, order);
      }

      await page.setViewportSize({ width: 1440, height: 900 });

      // ── 1. Default: nothing pinned, no dock, workflow order ──────────────────
      await page.goto(`${base}/tasks`);
      await page.evaluate(() => window.localStorage.clear());
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(cardOf(column(page, "TODO"), a1)).toBeVisible({ timeout: 30_000 });
      await expect(dock(page)).toHaveCount(0);
      expect(await columnTitles(scroller(page))).toEqual(["Backlog", "To Do", "In Progress", "Blocked", "In Review", "Done"]);
      await expect(page.getByRole("button", { name: "Pin Done to the right" })).toBeAttached();
      await expect(page.getByTestId("saved-views-trigger")).toBeVisible();
      await shot(page, "desktop-1-default-with-saved-views-menu");

      // ── 2. Pin DONE, then BLOCKED: one dock, two tabs, constant width ────────
      await page.getByRole("button", { name: "Pin Done to the right" }).click();
      await expect(dock(page)).toHaveCount(1);
      expect(await tabTitles(page)).toEqual(["Done"]);
      await expect(tab(page, "Done")).toHaveAttribute("aria-selected", "true");
      await expect(panel(page).getByText(d1)).toBeVisible();
      await expect(scroller(page).locator("[data-task-column=DONE]")).toHaveCount(0);
      const scrollerBox = (await scroller(page).boundingBox())!;
      const dockBox = (await dock(page).boundingBox())!;
      expect(dockBox.x, "the dock sits right of the scroller, not inside it").toBeGreaterThanOrEqual(scrollerBox.x + scrollerBox.width - 1);
      const openWidth = dockBox.width;
      await shot(page, "desktop-2-one-pinned-done");

      await page.getByRole("button", { name: "Pin Blocked to the right" }).click();
      expect(await tabTitles(page)).toEqual(["Blocked", "Done"]);
      await expect(tab(page, "Blocked")).toHaveAttribute("aria-selected", "true");
      await expect(panel(page).getByText(blocked)).toBeVisible();
      expect(Math.abs((await dockWidth(page)) - openWidth), "two pinned columns take no more room than one").toBeLessThanOrEqual(1);
      await tab(page, "Done").click();
      await expect(panel(page).getByText(d1)).toBeVisible();
      await expect(panel(page).getByText(blocked)).toHaveCount(0);
      await shot(page, "desktop-3-two-pinned-tab-switch");

      // ── 3a. Drop a To Do card on the BLOCKED tab while the Done panel is open ─
      await dragTo(page, cardOf(column(page, "TODO"), a2).getByLabel("Drag to reorder"), tab(page, "Blocked"));
      await expect.poll(() => statusOf(a2), { timeout: 15_000 }).toBe("BLOCKED");
      await page.reload();
      await page.waitForLoadState("networkidle");
      // This browser remembered the layout (two tabs, Done active) with no saved view.
      await expect(tab(page, "Done")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      expect(await tabTitles(page)).toEqual(["Blocked", "Done"]);
      await tab(page, "Blocked").click();
      await expect(panel(page).getByText(a2)).toBeVisible();
      await tab(page, "Done").click();

      // ── 3b. Drag a card out of the docked panel into a scroller column ───────
      const d1Card = cardOf(panel(page), d1);
      await dragTo(page, d1Card.getByLabel("Drag to reorder"), column(page, "TODO"), { alignCard: d1Card });
      await expect(cardOf(column(page, "TODO"), d1)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => statusOf(d1), { timeout: 15_000 }).toBe("TODO");
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(tab(page, "Done")).toBeVisible({ timeout: 30_000 });

      // ── 3c. Add a task from the docked panel's footer ────────────────────────
      await expect(tab(page, "Done")).toHaveAttribute("aria-selected", "true");
      await panel(page).getByRole("button", { name: /Add task/i }).click();
      await panel(page).getByLabel("Title").fill(added);
      await panel(page).getByRole("button", { name: "Add Task", exact: true }).click();
      await expect(cardOf(panel(page), added)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => statusOf(added), { timeout: 15_000 }).toBe("DONE");

      // ── 3d. In-column reorder still works, in the open panel and in the scroller ─
      const titlesIn = (root: Locator) => root.locator("[data-slot=card]").evaluateAll((els) => els.map((el) => el.textContent ?? ""));
      const indexOfTitle = (cards: string[], title: string) => cards.findIndex((text) => text.includes(title));
      const d3Card = cardOf(panel(page), d3);
      await dragTo(page, d3Card.getByLabel("Drag to reorder"), cardOf(panel(page), d2), { alignCard: d3Card });
      await expect.poll(async () => { const c = await titlesIn(panel(page)); return indexOfTitle(c, d3) < indexOfTitle(c, d2); }, { timeout: 15_000 }).toBe(true);
      const a3Card = cardOf(column(page, "TODO"), a3);
      await dragTo(page, a3Card.getByLabel("Drag to reorder"), cardOf(column(page, "TODO"), a1), { alignCard: a3Card });
      await expect.poll(async () => { const c = await titlesIn(column(page, "TODO")); return indexOfTitle(c, a3) < indexOfTitle(c, a1); }, { timeout: 15_000 }).toBe(true);
      await page.waitForTimeout(1_500);
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(tab(page, "Done")).toBeVisible({ timeout: 30_000 });
      { const c = await titlesIn(panel(page)); expect(indexOfTitle(c, d3), "the panel order persisted").toBeLessThan(indexOfTitle(c, d2)); }
      { const c = await titlesIn(column(page, "TODO")); expect(indexOfTitle(c, a3), "the scroller order persisted").toBeLessThan(indexOfTitle(c, a1)); }

      // ── 4. Show cancelled changes the column set, a pinned CANCELLED follows it ─
      await expect(column(page, "CANCELLED")).toHaveCount(0);
      await page.getByRole("button", { name: /^Show cancelled \(\d+\)$/ }).click();
      await expect(column(page, "CANCELLED")).toBeVisible();
      await page.getByRole("button", { name: "Pin Cancelled to the right" }).click();
      expect(await tabTitles(page)).toEqual(["Blocked", "Done", "Cancelled"]);
      await expect(panel(page).getByText(cancelled)).toBeVisible();
      await shot(page, "desktop-4-cancelled-pinned");
      await page.getByRole("button", { name: /^Hide cancelled \(\d+\)$/ }).click();
      expect(await tabTitles(page), "hiding cancelled removes its tab (the pin is kept)").toEqual(["Blocked", "Done"]);
      await page.getByRole("button", { name: /^Show cancelled \(\d+\)$/ }).click();
      expect(await tabTitles(page)).toEqual(["Blocked", "Done", "Cancelled"]);
      await panel(page).getByRole("button", { name: "Unpin Cancelled" }).click();
      expect(await tabTitles(page)).toEqual(["Blocked", "Done"]);
      await expect(column(page, "CANCELLED")).toBeVisible();
      await page.getByRole("button", { name: /^Hide cancelled/ }).click();

      // ── 5. Collapse, then 1280x800 and below md: no dock, pinned columns in the scroller ─
      await panel(page).getByRole("button", { name: /^Collapse / }).click();
      await expect(panel(page)).toHaveCount(0);
      await shot(page, "desktop-5-dock-collapsed");
      await tab(page, "Done").click();
      await expect(panel(page)).toBeVisible();
      await shot(page, "desktop-6-1280x800-pinned-persisted");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(dock(page)).toHaveCount(0);
      await expect(page.getByRole("tablist", { name: "Pinned columns" })).toHaveCount(0);
      await expect(scroller(page).locator("[data-task-column=DONE]")).toBeAttached();
      await expect(scroller(page).locator("[data-task-column=BLOCKED]")).toBeAttached();
      await expect(page.getByRole("button", { name: /^Pin .* to the right$/ })).toHaveCount(0);
      const mobileColumn = await scroller(page).locator("[data-task-column=TODO]").boundingBox();
      const mobileRegion = await scroller(page).boundingBox();
      expect(Math.abs(mobileColumn!.width - (mobileRegion!.width - 24)), "mobile columns keep their one-per-screen snap width").toBeLessThan(2);
      await shot(page, "narrow-390x844-no-dock-fallback");
    } finally {
      await pool.query(`DELETE FROM "${S}".tasks WHERE title LIKE $1`, [`E2E Dock % ${tag}`]);
      await pool.end();
    }
  });
});

test.describe("Tasks saved views", () => {
  test("save filters and layout, restore across a cleared browser, Modified/Reset, corrupt layout and delete", async ({ page, base }) => {
    test.setTimeout(300_000);
    const pool = requireLocalE2eDatabase();
    const tag = randomUUID().slice(0, 8);
    const high = `E2E Views High ${tag}`;
    const low = `E2E Views Low ${tag}`;
    const done = `E2E Views Done ${tag}`;
    const viewName = `E2E Tasks View ${tag}`;
    const renamed = `E2E Tasks View Renamed ${tag}`;

    try {
      const { workspaceId } = await workspaceIds(pool);
      await insertTask(pool, workspaceId, high, "TODO", -5000, "HIGH");
      await insertTask(pool, workspaceId, low, "TODO", -4999, "LOW");
      await insertTask(pool, workspaceId, done, "DONE", -5000, "HIGH");
      await page.setViewportSize({ width: 1440, height: 900 });

      // ── Save: a priority filter plus a pinned DONE ───────────────────────────
      await page.goto(`${base}/tasks?priority=HIGH`);
      await page.evaluate(() => window.localStorage.clear());
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(cardOf(column(page, "TODO"), high)).toBeVisible({ timeout: 30_000 });
      await expect(cardOf(column(page, "TODO"), low)).toHaveCount(0);
      await page.getByRole("button", { name: "Pin Done to the right" }).click();
      await expect(tab(page, "Done")).toHaveAttribute("aria-selected", "true");
      await page.getByTestId("saved-views-trigger").click();
      await shot(page, "desktop-7-saved-views-menu-open");
      await page.getByTestId("save-view-new").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill(viewName);
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 15_000 });
      await expect(page.getByTestId("saved-views-trigger")).toContainText(viewName);
      expect(new URL(page.url()).search, "the layout is not a URL param").not.toMatch(/pinned|layout|columnOrder|dock/i);

      type StoredLayout = { pinnedColumnIds: string[]; columnOrder: string[]; activePinnedId?: string | null; dockCollapsed?: boolean };
      const { rows } = await pool.query<{ id: string; surface: string; visibility: string; filters: { priority?: string }; display: { view?: string; columnLayout?: StoredLayout } }>(
        `SELECT id, surface, visibility, filters, display FROM "${S}".roadmap_views WHERE workspace_id = $1 AND name = $2`,
        [workspaceId, viewName],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ surface: "TASKS_BOARD", visibility: "PERSONAL", filters: { priority: "HIGH" } });
      expect(rows[0].display.columnLayout).toMatchObject({ pinnedColumnIds: ["DONE"], activePinnedId: "DONE", dockCollapsed: false });
      const viewId = rows[0].id;

      // ── Restore: this browser's own copy is cleared, so the VIEW must carry both ─
      await page.evaluate(() => window.localStorage.clear());
      await page.goto(`${base}/tasks?saved=${viewId}`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger")).toContainText(viewName, { timeout: 30_000 });
      await expect(page).toHaveURL(/priority=HIGH/);
      await expect(page).toHaveURL(/edited=1/);
      await expect(cardOf(column(page, "TODO"), high)).toBeVisible({ timeout: 30_000 });
      await expect(cardOf(column(page, "TODO"), low)).toHaveCount(0);
      await expect(tab(page, "Done")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      expect(await tabTitles(page)).toEqual(["Done"]);
      await expect(panel(page).getByText(done)).toBeVisible();
      await expect(page.getByTestId("saved-view-modified")).toHaveCount(0);

      // ── Modified / Reset: a layout change, then a filter change ──────────────
      await panel(page).getByRole("button", { name: "Collapse Done" }).click();
      await expect(page.getByTestId("saved-view-modified")).toBeVisible();
      await page.getByTestId("reset-view").click();
      await expect(page.getByTestId("saved-view-modified")).toHaveCount(0, { timeout: 15_000 });
      await expect(tab(page, "Done")).toHaveAttribute("aria-selected", "true");
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(2_000);

      await page.goto(`${base}/tasks?saved=${viewId}&edited=1&priority=LOW`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-view-modified")).toBeVisible({ timeout: 30_000 });
      await expect(cardOf(column(page, "TODO"), low)).toBeVisible({ timeout: 30_000 });
      await expect(cardOf(column(page, "TODO"), high)).toHaveCount(0);
      await page.getByTestId("reset-view").click();
      await expect(page.getByTestId("saved-view-modified")).toHaveCount(0, { timeout: 15_000 });
      await expect(page).toHaveURL(/priority=HIGH/, { timeout: 15_000 });
      await page.waitForLoadState("networkidle");

      // ── Rename keeps the saved state ─────────────────────────────────────────
      await page.getByRole("button", { name: `Edit view ${viewName}` }).click();
      await page.getByRole("dialog").getByLabel("Name").fill(renamed);
      await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByTestId("saved-views-trigger")).toContainText(renamed, { timeout: 15_000 });
      await expect(page.getByTestId("saved-view-modified")).toHaveCount(0);

      // ── Corrupt stored layout degrades to the defaults; the view still loads with its filter ─
      await pool.query(`UPDATE "${S}".roadmap_views SET display = display || '{"columnLayout": "garbage"}'::jsonb WHERE id = $1`, [viewId]);
      await page.evaluate(() => window.localStorage.clear());
      await page.goto(`${base}/tasks?saved=${viewId}`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("saved-views-trigger"), "the view itself still loads").toContainText(renamed, { timeout: 30_000 });
      await expect(cardOf(column(page, "TODO"), high)).toBeVisible({ timeout: 30_000 });
      await expect(cardOf(column(page, "TODO"), low)).toHaveCount(0);
      await expect(dock(page)).toHaveCount(0);
      expect(await columnTitles(scroller(page))).toEqual(["Backlog", "To Do", "In Progress", "Blocked", "In Review", "Done"]);

      // ── Delete ───────────────────────────────────────────────────────────────
      await page.getByRole("button", { name: `Delete view ${renamed}` }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
      await expect.poll(async () => (await pool.query(`SELECT 1 FROM "${S}".roadmap_views WHERE id = $1`, [viewId])).rowCount, { timeout: 15_000 }).toBe(0);
      await expect(page.getByTestId("saved-views-trigger")).not.toContainText(renamed, { timeout: 15_000 });
      // A deleted (or foreign) ?saved= id falls through to the defaults rather than failing the page.
      await page.goto(`${base}/tasks?saved=${viewId}`);
      await page.waitForLoadState("networkidle");
      await expect(cardOf(column(page, "TODO"), low)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("saved-views-trigger")).toContainText("Views");
    } finally {
      await pool.query(`DELETE FROM "${S}".roadmap_views WHERE name = ANY($1)`, [[viewName, renamed]]);
      await pool.query(`DELETE FROM "${S}".tasks WHERE title LIKE $1`, [`E2E Views % ${tag}`]);
      await pool.end();
    }
  });
});
