/**
 * Agent board dock (Compass TASK-111, PR 5 of the consistent pinned/tabbed dock program).
 *
 * The read-only Agent board uses the same ONE-dock-with-tabs as the other status boards. The layout is browser-local only
 * (localStorage key `compass:agent-board-column-layout:<workspaceId>`): there are no saved views and no drag and drop here.
 *   1. Nothing is pinned by default: no dock; empty Done/Failed/Ready columns stay hidden as before.
 *   2. Pin FAILED, then WORKING: one dock, two tabs, constant width; switch tabs; collapse and expand.
 *   3. A card in the docked panel opens its conversation and records the review; the board's polling (a run finishing, a new
 *      failure) updates the counts and cards without resetting the layout, the open tab or focus.
 *   4. A pinned column that empties (and so is hidden) loses its tab but keeps its pin; the tab returns with its first card.
 *   5. Reload restores the layout from localStorage; a corrupt stored layout degrades to the defaults.
 *   6. Below md there is no dock; pinned columns are ordinary scroller columns.
 *
 * Conversations and runs are seeded straight into the local compass_e2e database (no LLM turn). Set QA_SHOTS_DIR for screenshots.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";

const S = "compass_dev";

type Seeded = { id: string; title: string };

const scroller = (page: Page) => page.getByRole("region", { name: "Agent conversations by status" });
const dock = (page: Page) => page.getByTestId("board-pinned-region");
const tabs = (page: Page) => dock(page).getByRole("tab");
const tab = (page: Page, title: string) => dock(page).getByRole("tab", { name: new RegExp(`^${title} \\(`) });
const panel = (page: Page) => dock(page).getByRole("tabpanel");
const tabTitles = async (page: Page) => (await tabs(page).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""))).map((l) => l.replace(/ \(\d+\)$/, ""));
const columnTitles = (root: Locator) => root.locator("section > header h3").allTextContents();
const dockWidth = async (page: Page) => (await dock(page).boundingBox())!.width;
const cardId = (id: string) => `[data-board-card="${id}"]`;

function capturePageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.log(`[pageerror] ${error.message}\n${error.stack ?? "(no stack)"}`);
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

test("pin, tabs, collapse, open a card from the panel, polling keeps the layout, hidden empty columns, reload, corrupt storage and narrow screens", async ({ page, base }) => {
  test.setTimeout(300_000);
  const pageErrors = capturePageErrors(page);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const suffix = randomUUID().slice(0, 8);
  const seeded: Record<"working" | "failed" | "failed2" | "fresh" | "ready", Seeded> = {
    working: { id: randomUUID(), title: `Dock working ${suffix}` },
    failed: { id: randomUUID(), title: `Dock failed ${suffix}` },
    failed2: { id: randomUUID(), title: `Dock failed again ${suffix}` },
    fresh: { id: randomUUID(), title: `Dock new ${suffix}` },
    ready: { id: randomUUID(), title: `Dock ready ${suffix}` },
  };
  let workspaceId = "";
  let userId = "";
  const reviews = async (conversationId: string) =>
    (await pool.query(`SELECT reviewed_at FROM "${S}".agent_conversation_reviews WHERE conversation_id = $1 AND user_id = $2`, [conversationId, userId])).rows;

  async function seedConversation(s: Seeded, opts: { messages: boolean; run?: string; ageMinutes: number }) {
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW() - ($5 || ' minutes')::interval, NOW() - ($5 || ' minutes')::interval)`,
      [s.id, workspaceId, userId, s.title, String(opts.ageMinutes)],
    );
    if (opts.messages) {
      await pool.query(
        `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
         VALUES (gen_random_uuid(), $1, 'user', 'Question', $2, NOW() - ($3 || ' minutes')::interval),
                (gen_random_uuid(), $1, 'assistant', 'Answer', NULL, NOW() - ($3 || ' minutes')::interval)`,
        [s.id, userId, String(opts.ageMinutes)],
      );
    }
    if (opts.run) {
      await pool.query(
        `INSERT INTO "${S}".agent_runs (id, conversation_id, workspace_id, user_id, status, worker_token_hash, deadline_at, status_changed_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW() + interval '1 hour', NOW() - ($6 || ' minutes')::interval)`,
        [s.id, workspaceId, userId, opts.run, randomUUID().replaceAll("-", "").padEnd(64, "0"), String(opts.ageMinutes)],
      );
    }
  }
  const removeConversation = async (s: Seeded) => {
    await pool.query(`DELETE FROM "${S}".agent_conversation_reviews WHERE conversation_id = $1`, [s.id]);
    await pool.query(`DELETE FROM "${S}".agent_runs WHERE conversation_id = $1`, [s.id]);
    await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = $1`, [s.id]);
    await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = $1`, [s.id]);
  };

  try {
    const { rows: [ids] } = await pool.query<{ workspace_id: string; owner_id: string }>(
      `SELECT w.id AS workspace_id, (SELECT id FROM "${S}".users WHERE email = 'dev@localhost.dev') AS owner_id
         FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id
        WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace'`,
    );
    workspaceId = ids.workspace_id;
    userId = ids.owner_id;
    const storageKey = `compass:agent-board-column-layout:${workspaceId}`;

    await seedConversation(seeded.working, { messages: true, run: "RUNNING", ageMinutes: 1 });
    await seedConversation(seeded.failed, { messages: true, run: "FAILED", ageMinutes: 5 });
    await seedConversation(seeded.fresh, { messages: true, run: "SUCCEEDED", ageMinutes: 10 });

    // ── 1. Default: Board view, nothing pinned, empty columns hidden ─────────
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/agent`);
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    await expect(page.getByTestId("agent-board")).toBeVisible();
    await expect(page.locator(cardId(seeded.failed.id))).toBeVisible({ timeout: 30_000 });
    await expect(dock(page)).toHaveCount(0);
    const defaultColumns = await columnTitles(scroller(page));
    expect(defaultColumns.slice(0, 2), "Working and New are first, in Geode's order").toEqual(["Working", "New"]);
    expect(defaultColumns).not.toContain("Ready");
    await shot(page, "desktop-1-agent-default");

    // ── 2. Pin FAILED, then WORKING: one dock, two tabs, constant width ──────
    await page.getByRole("button", { name: "Pin Failed to the right" }).click();
    await expect(dock(page)).toHaveCount(1);
    expect(await tabTitles(page)).toEqual(["Failed"]);
    await expect(tab(page, "Failed")).toHaveAttribute("aria-selected", "true");
    await expect(panel(page).locator(cardId(seeded.failed.id))).toBeVisible();
    await expect(scroller(page).locator("[data-board-column=failed]")).toHaveCount(0);
    const scrollerBox = (await scroller(page).boundingBox())!;
    const dockBox = (await dock(page).boundingBox())!;
    expect(dockBox.x, "the dock sits right of the scroller, not inside it").toBeGreaterThanOrEqual(scrollerBox.x + scrollerBox.width - 1);
    const openWidth = dockBox.width;
    await shot(page, "desktop-2-agent-one-pinned-failed");

    await page.getByRole("button", { name: "Pin Working to the right" }).click();
    expect(await tabTitles(page)).toEqual(["Working", "Failed"]);
    await expect(tab(page, "Working")).toHaveAttribute("aria-selected", "true");
    await expect(panel(page).locator(cardId(seeded.working.id))).toBeVisible();
    expect(Math.abs((await dockWidth(page)) - openWidth), "two pinned columns take no more room than one").toBeLessThanOrEqual(1);
    await tab(page, "Failed").click();
    await expect(panel(page).locator(cardId(seeded.failed.id))).toBeVisible();
    await expect(panel(page).locator(cardId(seeded.working.id))).toHaveCount(0);
    await shot(page, "desktop-3-agent-two-pinned-tab-switch");

    // ── 2b. Collapse and expand ──────────────────────────────────────────────
    await panel(page).getByRole("button", { name: /^Collapse / }).click();
    await expect(panel(page)).toHaveCount(0);
    await shot(page, "desktop-4-agent-dock-collapsed");
    await tab(page, "Failed").click();
    await expect(panel(page)).toBeVisible();

    // ── 3a. Polling: a new failure arrives; the layout, the open tab and the tab focus stay ─
    await tab(page, "Failed").focus();
    const storedBefore = await page.evaluate((key) => window.localStorage.getItem(key), storageKey);
    await seedConversation(seeded.failed2, { messages: true, run: "FAILED", ageMinutes: 0 });
    await expect(panel(page).locator(cardId(seeded.failed2.id))).toBeVisible({ timeout: 20_000 });
    await expect(tab(page, "Failed")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Failed")).toHaveAttribute("aria-label", /\(2\)$/);
    expect(await tabTitles(page)).toEqual(["Working", "Failed"]);
    await expect(tab(page, "Failed")).toBeFocused();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), storageKey), "polling did not rewrite the layout").toBe(storedBefore);

    // ── 3b. A card in the docked panel opens its conversation and records the review ─
    expect(await reviews(seeded.failed.id)).toHaveLength(0);
    await panel(page).locator(cardId(seeded.failed.id)).click();
    await page.waitForURL(new RegExp(`c=${seeded.failed.id}`));
    await expect(page.getByText("Answer").first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await reviews(seeded.failed.id)).length, { timeout: 15_000 }).toBe(1);
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    await expect(tab(page, "Failed")).toBeVisible({ timeout: 30_000 });
    expect(await tabTitles(page), "the layout survived leaving and returning to the board").toEqual(["Working", "Failed"]);

    // ── 4. A pinned column that empties is hidden (tab gone, pin kept) and returns with its first card ─
    await seedConversation(seeded.ready, { messages: false, ageMinutes: 30 });
    await expect(page.locator(cardId(seeded.ready.id))).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Pin Ready to the right" }).click();
    await expect(tab(page, "Ready")).toHaveAttribute("aria-selected", "true");
    expect(await tabTitles(page)).toEqual(["Working", "Failed", "Ready"]);
    await removeConversation(seeded.ready);
    await expect(tab(page, "Ready")).toHaveCount(0, { timeout: 20_000 });
    expect(await tabTitles(page)).toEqual(["Working", "Failed"]);
    await expect(panel(page).locator("section > header h3")).toHaveText(/^(Working|Failed)$/);
    expect(JSON.parse((await page.evaluate((key) => window.localStorage.getItem(key), storageKey))!).pinnedColumnIds, "the pin is kept while the column is hidden").toContain("ready");
    await seedConversation(seeded.ready, { messages: false, ageMinutes: 30 });
    await expect(tab(page, "Ready")).toBeVisible({ timeout: 20_000 });
    expect(await tabTitles(page)).toEqual(["Working", "Failed", "Ready"]);
    await removeConversation(seeded.ready);
    await expect(tab(page, "Ready")).toHaveCount(0, { timeout: 20_000 });
    // (the stored active tab was the hidden Ready: the dock showed the first docked tab meanwhile)
    await tab(page, "Failed").click();
    await expect(tab(page, "Failed")).toHaveAttribute("aria-selected", "true");
    await expect(panel(page)).toBeVisible();

    // ── 5. Reload restores the layout from localStorage ──────────────────────
    await page.goto(`${base}/agent`); // (a ?c= deep link would show the chat)
    await expect(tab(page, "Failed")).toBeVisible({ timeout: 30_000 });
    expect(await tabTitles(page)).toEqual(["Working", "Failed"]);
    await expect(tab(page, "Failed")).toHaveAttribute("aria-selected", "true");

    // ── 5b. A corrupt stored layout degrades to the defaults ─────────────────
    await page.evaluate((key) => window.localStorage.setItem(key, "{not json"), storageKey);
    await page.goto(`${base}/agent`); // (a ?c= deep link would show the chat)
    await expect(page.locator(cardId(seeded.failed.id))).toBeVisible({ timeout: 30_000 });
    await expect(dock(page)).toHaveCount(0);
    await page.evaluate((key) => window.localStorage.setItem(key, JSON.stringify({ columnOrder: 5, pinnedColumnIds: "x" })), storageKey);
    await page.goto(`${base}/agent`); // (a ?c= deep link would show the chat)
    await expect(page.locator(cardId(seeded.failed.id))).toBeVisible({ timeout: 30_000 });
    await expect(dock(page)).toHaveCount(0);

    // ── 6. Below md: no dock, pinned columns in the scroller in saved order ──
    await page.evaluate((key) => window.localStorage.setItem(key, JSON.stringify({ columnOrder: ["failed", "working", "new", "done", "ready"], pinnedColumnIds: ["failed"], activePinnedId: "failed", dockCollapsed: false })), storageKey);
    await page.goto(`${base}/agent`); // (a ?c= deep link would show the chat)
    await expect(tab(page, "Failed")).toBeVisible({ timeout: 30_000 });
    await shot(page, "desktop-5-agent-1280x800-pinned-persisted");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dock(page)).toHaveCount(0);
    expect((await columnTitles(scroller(page))).slice(0, 3), "pinned columns render in the scroller in saved order").toEqual(["Failed", "Working", "New"]);
    await expect(page.getByRole("button", { name: /^Pin .* to the right$/ })).toHaveCount(0);
    const widths = await page.locator("[data-board-column]").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(279);
    await scroller(page).evaluate((el) => el.scrollTo({ left: 0 })); // the desktop scroll offset survives the resize
    await shot(page, "narrow-390x844-agent-no-dock-fallback");
    expect(pageErrors, "no uncaught page errors during the journey").toEqual([]);
  } finally {
    for (const s of Object.values(seeded)) await removeConversation(s).catch(() => {});
    await pool.end();
  }
});
