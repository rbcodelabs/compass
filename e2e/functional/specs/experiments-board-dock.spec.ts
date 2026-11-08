/**
 * Experiments board dock (Compass TASK-111, PR 5 of the consistent pinned/tabbed dock program).
 *
 * The Experiments board uses the same ONE-dock-with-tabs as the roadmap, Solutions, Opportunity and Tasks boards. The layout is
 * browser-local only (localStorage key `compass:experiments-column-layout:<workspaceId>`): there are no saved views here.
 *   1. Nothing is pinned by default: no dock, the lifecycle order (Designing ... Killed).
 *   2. Pin COMPLETE, then KILLED: one dock, two tabs, the dock keeps its width; switch tabs; collapse and expand.
 *   3. Hover a card over a closed tab (it must not move or unmount), press Escape (it is restored, nothing is written);
 *      drop a card on the closed KILLED tab; drag a card out of the open panel into a scroller column.
 *   4. Reload restores the layout from localStorage; a corrupt stored layout degrades to the defaults.
 *   5. Below md there is no dock; pinned columns are ordinary scroller columns.
 *
 * Fixtures go straight into the local compass_e2e database and are removed in `finally`. Set QA_SHOTS_DIR to also write screenshots.
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
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.startsWith("/compass_e2e")) {
    throw new Error("Experiments dock tests require the dedicated local compass_e2e database");
  }
  return new pg.Pool({ connectionString: url.toString() });
}

/** Stepped real mouse movement (see tasks-board-dock.spec.ts); `alignCard` aims the dragged CARD's centre at the target. */
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

const scroller = (page: Page) => page.getByRole("region", { name: "Experiment board" });
const dock = (page: Page) => page.getByTestId("board-pinned-region");
const tabs = (page: Page) => dock(page).getByRole("tab");
const tab = (page: Page, title: string) => dock(page).getByRole("tab", { name: new RegExp(`^${title} \\(`) });
const panel = (page: Page) => dock(page).getByRole("tabpanel");
const tabTitles = async (page: Page) => (await tabs(page).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""))).map((l) => l.replace(/ \(\d+\)$/, ""));
const columnTitles = (root: Locator) => root.locator("section > header h3").allTextContents();
const dockWidth = async (page: Page) => (await dock(page).boundingBox())!.width;
const column = (page: Page, status: string) => page.locator(`[data-experiment-column='${status}']`);
const cardOf = (root: Locator, title: string) => root.locator("[data-slot=card]", { hasText: title });

/** Collects uncaught page errors (with stacks); the journey asserts none occurred. */
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
  const before = page.viewportSize();
  const doResize = resize && before !== null && before.width >= 1000 && before.width !== 1280;
  if (doResize) { await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(400); }
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
  if (doResize && before) await page.setViewportSize(before);
}

async function workspaceId(pool: pg.Pool) {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT w.id FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $1 AND w.slug = $2`,
    [ORG, WORKSPACE],
  );
  return rows[0].id;
}

async function insertExperiment(pool: pg.Pool, wsId: string, title: string, status: string, sortOrder: number) {
  await pool.query(
    `INSERT INTO "${S}".experiments (id, workspace_id, title, hypothesis, method, kill_condition, status, sort_order, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'We believe this works', 'A/B test', 'Stop if it does not', $3, $4, NOW(), NOW())`,
    [wsId, title, status, sortOrder],
  );
}

test.describe("Experiments board dock", () => {
  test("pin, tabs, collapse, drag onto a tab, hover and Escape, drag out, reload, corrupt storage and narrow screens", async ({ page, base }) => {
    test.setTimeout(300_000);
    const pageErrors = capturePageErrors(page);
    const pool = requireLocalE2eDatabase();
    const tag = randomUUID().slice(0, 8);
    const t = (name: string) => `E2E Dock ${name} ${tag}`;
    const [d1, d2, d3, running, c1, c2, killed] = ["D1", "D2", "D3", "Running", "C1", "C2", "Killed"].map(t);
    const statusOf = async (title: string) => (await pool.query<{ status: string }>(`SELECT status FROM "${S}".experiments WHERE title = $1`, [title])).rows[0]?.status;

    try {
      const wsId = await workspaceId(pool);
      const storageKey = `compass:experiments-column-layout:${wsId}`;
      for (const [title, status, order] of [[d1, "DESIGNING", -5000], [d2, "DESIGNING", -4999], [d3, "DESIGNING", -4998], [running, "RUNNING", -5000], [c1, "COMPLETE", -5000], [c2, "COMPLETE", -4999], [killed, "KILLED", -5000]] as const) {
        await insertExperiment(pool, wsId, title, status, order);
      }
      await page.setViewportSize({ width: 1440, height: 900 });

      // ── 1. Default: nothing pinned, no dock, lifecycle order ─────────────────
      await page.goto(`${base}/experiments`);
      await page.evaluate(() => window.localStorage.clear());
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(cardOf(column(page, "DESIGNING"), d1)).toBeVisible({ timeout: 30_000 });
      await expect(dock(page)).toHaveCount(0);
      expect(await columnTitles(scroller(page))).toEqual(["Designing", "Running", "Complete", "Killed"]);
      await expect(page.getByRole("button", { name: "Pin Killed to the right" })).toBeAttached();
      await shot(page, "desktop-1-default");

      // ── 2. Pin COMPLETE, then KILLED: one dock, two tabs, constant width ─────
      await page.getByRole("button", { name: "Pin Complete to the right" }).click();
      await expect(dock(page)).toHaveCount(1);
      expect(await tabTitles(page)).toEqual(["Complete"]);
      await expect(tab(page, "Complete")).toHaveAttribute("aria-selected", "true");
      await expect(panel(page).getByText(c1)).toBeVisible();
      await expect(scroller(page).locator("[data-experiment-column=COMPLETE]")).toHaveCount(0);
      const scrollerBox = (await scroller(page).boundingBox())!;
      const dockBox = (await dock(page).boundingBox())!;
      expect(dockBox.x, "the dock sits right of the scroller, not inside it").toBeGreaterThanOrEqual(scrollerBox.x + scrollerBox.width - 1);
      const openWidth = dockBox.width;
      await shot(page, "desktop-2-one-pinned-complete");

      await page.getByRole("button", { name: "Pin Killed to the right" }).click();
      expect(await tabTitles(page)).toEqual(["Complete", "Killed"]);
      await expect(tab(page, "Killed")).toHaveAttribute("aria-selected", "true");
      await expect(panel(page).getByText(killed)).toBeVisible();
      expect(Math.abs((await dockWidth(page)) - openWidth), "two pinned columns take no more room than one").toBeLessThanOrEqual(1);
      await tab(page, "Complete").click();
      await expect(panel(page).getByText(c1)).toBeVisible();
      await expect(panel(page).getByText(killed)).toHaveCount(0);
      await shot(page, "desktop-3-two-pinned-tab-switch");

      // ── 2b. Collapse and expand ──────────────────────────────────────────────
      await panel(page).getByRole("button", { name: /^Collapse / }).click();
      await expect(panel(page)).toHaveCount(0);
      expect(await tabTitles(page)).toEqual(["Complete", "Killed"]);
      await shot(page, "desktop-4-dock-collapsed");
      await tab(page, "Complete").click();
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).getByText(c1)).toBeVisible();

      // ── 3a. Hovering a card over a closed tab must not move or unmount it ────
      // Complete is the open panel, so the Killed tab has no column behind it.
      {
        const killedTabLabel = await tab(page, "Killed").getAttribute("aria-label");
        const d1Card = cardOf(column(page, "DESIGNING"), d1);
        const handleBox = (await d1Card.getByLabel("Drag to reorder").boundingBox())!;
        const sx = handleBox.x + handleBox.width / 2;
        const sy = handleBox.y + handleBox.height / 2;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        await page.mouse.move(sx + 15, sy + 15, { steps: 10 });
        const tabBox = (await tab(page, "Killed").boundingBox())!;
        await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2, { steps: 30 });
        await page.waitForTimeout(600);
        // The path crosses ordinary columns and the open panel (where an optimistic move is the long-standing behaviour); the tab
        // itself is never an optimistic target, so the card is still mounted (the original plus the drag overlay's copy: 2, where an
        // unmounted original would leave 1) and the Killed tab is unchanged.
        await expect(page.locator("[data-slot=card]", { hasText: d1 }), "the dragged card stays mounted").toHaveCount(2);
        await expect(tab(page, "Killed")).toHaveAttribute("aria-label", killedTabLabel!);
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await expect(cardOf(column(page, "DESIGNING"), d1), "Escape restores the card").toBeVisible();
        expect(await statusOf(d1), "nothing was written").toBe("DESIGNING");
        await expect(tab(page, "Killed")).toHaveAttribute("aria-label", killedTabLabel!);
        expect(pageErrors, "no page errors while hovering a tab").toEqual([]);
      }

      // ── 3b. Drop a Designing card on the closed KILLED tab ───────────────────
      await dragTo(page, cardOf(column(page, "DESIGNING"), d2).getByLabel("Drag to reorder"), tab(page, "Killed"));
      await expect.poll(() => statusOf(d2), { timeout: 15_000 }).toBe("KILLED");
      await page.reload();
      await page.waitForLoadState("networkidle");

      // ── 4a. This browser remembered the layout (two tabs, Complete active) ───
      await expect(tab(page, "Complete")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      expect(await tabTitles(page)).toEqual(["Complete", "Killed"]);
      const stored = JSON.parse((await page.evaluate((key) => window.localStorage.getItem(key), storageKey))!);
      expect(stored).toMatchObject({ pinnedColumnIds: ["COMPLETE", "KILLED"], activePinnedId: "COMPLETE", dockCollapsed: false });
      await tab(page, "Killed").click();
      await expect(panel(page).getByText(d2)).toBeVisible();
      await tab(page, "Complete").click();

      // ── 3c. Drag a card out of the docked panel into a scroller column ───────
      const c1Card = cardOf(panel(page), c1);
      await dragTo(page, c1Card.getByLabel("Drag to reorder"), column(page, "RUNNING"), { alignCard: c1Card });
      await expect(cardOf(column(page, "RUNNING"), c1)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => statusOf(c1), { timeout: 15_000 }).toBe("RUNNING");
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(tab(page, "Complete")).toBeVisible({ timeout: 30_000 });
      await expect(cardOf(column(page, "RUNNING"), c1)).toBeVisible();

      // ── 4b. A corrupt stored layout degrades to the defaults ─────────────────
      await page.evaluate((key) => window.localStorage.setItem(key, "{not json"), storageKey);
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(cardOf(column(page, "DESIGNING"), d1)).toBeVisible({ timeout: 30_000 });
      await expect(dock(page)).toHaveCount(0);
      expect(await columnTitles(scroller(page))).toEqual(["Designing", "Running", "Complete", "Killed"]);
      await page.evaluate((key) => window.localStorage.setItem(key, JSON.stringify({ columnOrder: 5, pinnedColumnIds: "x" })), storageKey);
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(cardOf(column(page, "DESIGNING"), d1)).toBeVisible({ timeout: 30_000 });
      await expect(dock(page)).toHaveCount(0);

      // ── 5. Below md: no dock, pinned columns in the scroller in saved order ──
      await page.evaluate((key) => window.localStorage.setItem(key, JSON.stringify({ columnOrder: ["KILLED", "DESIGNING", "RUNNING", "COMPLETE"], pinnedColumnIds: ["KILLED"], activePinnedId: "KILLED", dockCollapsed: false })), storageKey);
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(tab(page, "Killed")).toBeVisible({ timeout: 30_000 });
      await shot(page, "desktop-5-1280x800-pinned-persisted");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(dock(page)).toHaveCount(0);
      await expect(page.getByRole("tablist", { name: "Pinned columns" })).toHaveCount(0);
      expect(await columnTitles(scroller(page)), "pinned columns render in the scroller in saved order").toEqual(["Killed", "Designing", "Running", "Complete"]);
      await expect(page.getByRole("button", { name: /^Pin .* to the right$/ })).toHaveCount(0);
      const mobileColumn = await column(page, "RUNNING").boundingBox();
      const mobileRegion = await scroller(page).boundingBox();
      expect(Math.abs(mobileColumn!.width - (mobileRegion!.width - 24)), "mobile columns keep their one-per-screen snap width").toBeLessThan(2);
      await scroller(page).evaluate((el) => el.scrollTo({ left: 0 })); // the desktop scroll offset survives the resize
      await shot(page, "narrow-390x844-no-dock-fallback");
      expect(pageErrors, "no uncaught page errors during the journey").toEqual([]);
    } finally {
      await pool.query(`DELETE FROM "${S}".experiments WHERE title LIKE $1`, [`E2E Dock % ${tag}`]);
      await pool.end();
    }
  });
});
