/**
 * Regression: leaving a detail panel while its data loads must not reopen it.
 *
 * Next.js 16.2 serializes every server action through the router's action
 * queue. When a navigation preempts a pending action, the queue can start the
 * *next* queued action against the pre-navigation router state; when that
 * action settles, its captured state (URL `?detail=…`) is committed, and the
 * panel the user just left reappears (fixed upstream in Next 16.3's
 * app-router-instance `runRemainingActions`).
 *
 * The panels hit this because a few of them loaded read-only data through
 * server actions from effects (MeasurementsPanel, the task assignee picker),
 * so every panel open put two or more actions in that queue. They now read
 * through GET route handlers like the rest of the panel data, which never
 * enter the router queue.
 *
 * The race is driven deterministically by holding requests at the network:
 *  1. open the panel and hold its first data read (R1);
 *  2. start the navigation away and hold its RSC request (N);
 *  3. release R1. With server-action reads, the router queue now dispatches
 *     the next queued read (R2) against the pre-navigation state — give it a
 *     bounded window to appear, and hold it;
 *  4. release N and wait for the destination URL to commit;
 *  5. release only the reads dispatched from the panel URL (R2) and assert the
 *     URL never returns to `?detail=…`; then release everything else.
 * Before the fix, R2 committed its stale `?detail=…` state in step 5. After
 * it, reads are GETs that never enter the router queue, so there is no R2.
 */
import type { Page, Route } from "@playwright/test";
import getPrisma from "../../../lib/db";
import { test, expect } from "../fixtures/index";

/** Bounded window for the router to dispatch a queued read after R1 settles. */
const QUEUED_READ_WINDOW_MS = 3_000;

function isPanelRead(url: string, method: string, headers: Record<string, string>) {
  return (method === "POST" && Boolean(headers["next-action"])) ||
    /\/api\/(analytics\/measurements|panels\/task-assignees)\b/.test(url);
}

function isNavigation(method: string, headers: Record<string, string>) {
  return method === "GET" && headers["rsc"] === "1" && !headers["next-router-prefetch"];
}

async function holdNetwork(page: Page) {
  const reads: Array<{ url: string; release: () => Promise<void> }> = [];
  const navigations: Array<{ url: string; release: () => Promise<void> }> = [];
  let seenReads = 0;
  let seenNavigations = 0;
  let holdingNavigations = true;
  await page.route("**/*", async (route: Route) => {
    const request = route.request();
    const headers = request.headers();
    const read = isPanelRead(request.url(), request.method(), headers);
    const navigation = isNavigation(request.method(), headers);
    if (!read && !(navigation && holdingNavigations)) return route.fallback();
    await new Promise<void>((resolve) => {
      const release = async () => { resolve(); };
      const held = { url: request.url(), release };
      if (read) { seenReads += 1; reads.push(held); } else { seenNavigations += 1; navigations.push(held); }
    });
    await route.fallback();
  });
  type Held = { url: string; release: () => Promise<void> };
  const releaseAll = async (held: Held[]) => { for (const { release } of held.splice(0)) await release(); };
  return {
    seenReads: () => seenReads,
    waitForRead: () => expect.poll(() => seenReads).toBeGreaterThan(0),
    waitForNavigation: () => expect.poll(() => seenNavigations).toBeGreaterThan(0),
    /** After releasing reads, give a queued read a bounded chance to be dispatched. */
    releaseReadsAndAwaitQueued: async () => {
      const before = seenReads;
      await releaseAll(reads);
      await expect.poll(() => seenReads, { timeout: QUEUED_READ_WINDOW_MS }).toBeGreaterThan(before).catch(() => undefined);
    },
    /** Release N and stop holding navigations (the router may issue follow-up RSC fetches). */
    releaseNavigations: () => { holdingNavigations = false; return releaseAll(navigations); },
    /** Release only reads dispatched from the panel URL, and wait for their responses. */
    releaseStaleReads: async () => {
      const stale = reads.filter((held) => held.url.includes("detail="));
      for (const held of stale) reads.splice(reads.indexOf(held), 1);
      const finished = stale.map((held) => page.waitForEvent("requestfinished", { predicate: (r) => r.url() === held.url }));
      for (const held of stale) await held.release();
      await Promise.all(finished);
      return stale.length;
    },
    releaseEverything: async () => { await page.unroute("**/*"); await releaseAll(reads); await releaseAll(navigations); },
  };
}

async function idOf(workspaceSlug: string, model: "experiment" | "task" | "roadmapItem", title: string) {
  const prisma = getPrisma();
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } });
  const where = { workspaceId: workspace.id, title };
  const row =
    model === "experiment"
      ? await prisma.experiment.findFirstOrThrow({ where, select: { id: true } })
      : model === "task"
        ? await prisma.task.findFirstOrThrow({ where, select: { id: true } })
        : await prisma.roadmapItem.findFirstOrThrow({ where, select: { id: true } });
  return row.id;
}

async function leaveAndExpectToStay(page: Page, panelUrl: string, leave: () => Promise<void>, destination: RegExp) {
  const network = await holdNetwork(page);
  await page.goto(panelUrl);
  await network.waitForRead();                   // 1. R1 held
  await leave();                                 // 2. start navigating away
  await network.waitForNavigation();             //    N held
  await network.releaseReadsAndAwaitQueued();    // 3. R1 settles mid-navigation
  await network.releaseNavigations();            // 4. N commits
  await expect(page).toHaveURL(destination);
  const visited: string[] = [];
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) visited.push(frame.url()); });
  await network.releaseStaleReads();             // 5. reads from the panel URL settle first
  // Two animation frames: long enough for React to commit any router state
  // those responses produced, with nothing else in flight to mask it.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page).toHaveURL(destination);
  expect(visited.filter((url) => url.includes("detail="))).toEqual([]);
  await network.releaseEverything();             //    then everything else
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveURL(destination);
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
}

test.describe("Detail panel reads do not reopen a panel after navigation", () => {
  test("experiment panel → Open full page stays on the full page", async ({ page, base, workspaceSlug }) => {
    const id = await idOf(workspaceSlug, "experiment", "E2E Baseline Experiment");
    await leaveAndExpectToStay(page, `${base}/experiments?detail=experiment:${id}`, async () => {
      const link = page.locator('[data-slot="sheet-content"]').getByRole("link", { name: "Open full page" });
      await link.click();
    }, new RegExp(`${base}/experiments/${id}$`));
  });

  test("task panel → Open full page stays on the full page", async ({ page, base, workspaceSlug }) => {
    const id = await idOf(workspaceSlug, "task", "E2E Baseline Task");
    await leaveAndExpectToStay(page, `${base}/tasks?detail=task:${id}`, async () => {
      await page.locator('[data-slot="sheet-content"]').getByRole("link", { name: "Open full page" }).click();
    }, new RegExp(`${base}/tasks/${id}$`));
  });

  test("roadmap item panel closed with Escape stays closed", async ({ page, base, workspaceSlug }) => {
    const id = await idOf(workspaceSlug, "roadmapItem", "E2E Baseline Roadmap");
    await leaveAndExpectToStay(page, `${base}/roadmap?detail=roadmapItem:${id}`, async () => {
      await expect(page.getByRole("dialog", { name: "Roadmap Item", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }, new RegExp(`${base}/roadmap$`));
  });
});
