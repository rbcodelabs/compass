import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

test.use({ hasTouch: true, isMobile: true });

async function swipe(page: Page, card: Locator, dx: number, dy: number) {
  const box = (await card.boundingBox())!;
  const x = Math.min(box.x + box.width / 2, 280);
  const y = box.y + box.height / 2;
  // Real browser touch input, starting on card content rather than its drag
  // handle. Setting scrollTop would conceal touch-action interception.
  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++) {
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 8, y: y + dy * step / 8 }] });
    await page.waitForTimeout(20);
  }
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await touch.detach();
}

const boards = [
  { route: "tasks", table: "tasks", extra: "status", value: "BACKLOG" },
  { route: "discovery", table: "opportunities", extra: "status", value: "EXPLORING" },
  { route: "experiments", table: "experiments", extra: "status", value: "DESIGNING" },
  { route: "roadmap", table: "roadmap_items", extra: "horizon", value: "NOW" },
] as const;

test("solution swimlane card content supports vertical and horizontal touch scrolling", async ({ page, base }) => {
  const database = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(database.hostname) || database.pathname !== "/compass_e2e") {
    throw new Error("Kanban scroll test requires the dedicated local compass_e2e database");
  }
  const pool = new pg.Pool({ connectionString: database.toString() });
  const opportunityId = randomUUID();
  const ids = Array.from({ length: 18 }, () => randomUUID());
  try {
    const workspace = (await pool.query("SELECT w.id FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON w.organization_id=o.id WHERE w.slug='e2e-workspace' AND o.slug='e2e-test-org'")).rows[0];
    await pool.query("INSERT INTO compass_dev.opportunities (id,workspace_id,title,sort_order) VALUES ($1,$2,'Mobile solution lane',-100)", [opportunityId, workspace.id]);
    for (const [index, id] of ids.entries()) {
      await pool.query("INSERT INTO compass_dev.solutions (id,opportunity_id,title,sort_order) VALUES ($1,$2,$3,$4)", [id, opportunityId, `Mobile solution ${index + 1}`, index]);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/discovery?view=board&groupBy=opportunity`);
    await page.waitForLoadState("networkidle");
    const first = page.getByText("Mobile solution 1", { exact: true });
    await expect(first).toBeInViewport();
    const firstTop = (await first.boundingBox())!.y;
    await swipe(page, first, 0, -140);
    await expect.poll(async () => (await first.boundingBox())!.y).toBeLessThan(firstTop - 50);
    await page.reload();
    await page.waitForLoadState("networkidle");
    const firstLeft = (await first.boundingBox())!.x;
    await swipe(page, first, -80, 0);
    await expect.poll(async () => (await first.boundingBox())!.x).toBeLessThan(firstLeft - 35);
  } finally {
    await pool.query("DELETE FROM compass_dev.solutions WHERE id=ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM compass_dev.opportunities WHERE id=$1", [opportunityId]);
    await pool.end();
  }
});

for (const board of boards) {
  test(`${board.route} mobile Kanban scrolls by wheel and touch while desktop keeps independent columns`, async ({ page, base }, testInfo) => {
    const database = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1"].includes(database.hostname) || database.pathname !== "/compass_e2e") {
      throw new Error("Kanban scroll test requires the dedicated local compass_e2e database");
    }
    const pool = new pg.Pool({ connectionString: database.toString() });
    const ids = Array.from({ length: 18 }, () => randomUUID());
    try {
      const workspace = (await pool.query("SELECT w.id FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON w.organization_id=o.id WHERE w.slug='e2e-workspace' AND o.slug='e2e-test-org'")).rows[0];
      for (const [index, id] of ids.entries()) {
        const extraColumns = board.route === "experiments" ? ",hypothesis,method,kill_condition" : "";
        const extraValues = board.route === "experiments" ? ",'Test hypothesis','Test method','Test stop condition'" : "";
        // Table and column names come only from the static cases above.
        await pool.query(`INSERT INTO compass_dev.${board.table} (id, workspace_id, title, sort_order, ${board.extra}${extraColumns}) VALUES ($1,$2,$3,$4,$5${extraValues})`, [id, workspace.id, `Mobile scroll card ${index + 1}`, index - 100, board.value]);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base}/${board.route}?view=board`);
      await page.waitForLoadState("networkidle");
      const first = page.getByText("Mobile scroll card 1", { exact: true });
      const last = page.getByText("Mobile scroll card 18", { exact: true });
      await expect(first).toBeInViewport();
      await expect(last).not.toBeInViewport();
      await page.mouse.move(170, 550);
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, 650);
        await page.waitForTimeout(100);
      }
      await expect(last).toBeInViewport();
      await expect(first).not.toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`${board.route}-mobile-bottom.png`) });

      await page.reload();
      await page.waitForLoadState("networkidle");
      const firstTop = (await first.boundingBox())!.y;
      await swipe(page, first, 0, -140);
      await expect.poll(async () => (await first.boundingBox())!.y).toBeLessThan(firstTop - 50);

      await page.reload();
      await page.waitForLoadState("networkidle");
      const firstLeft = (await first.boundingBox())!.x;
      await swipe(page, first, -140, 0);
      await expect.poll(async () => (await first.boundingBox())!.x).toBeLessThan(firstLeft - 50);

      if (board.route === "tasks") {
        await page.reload();
        await page.waitForLoadState("networkidle");
        const second = page.getByText("Mobile scroll card 2", { exact: true });
        const secondCard = second.locator("xpath=ancestor::*[@data-slot='card'][1]");
        const handle = secondCard.getByRole("button", { name: "Drag to reorder" });
        const delta = (await first.boundingBox())!.y - (await second.boundingBox())!.y;
        const saved = page.waitForResponse(response =>
          response.request().method() === "POST" &&
          Boolean(response.request().headers()["next-action"]) &&
          new URL(response.url()).pathname === `${base}/tasks`
        );
        await swipe(page, handle, 0, delta);
        const response = await saved;
        expect(await response.finished()).toBeNull();
        expect(response.ok()).toBe(true);
        await page.reload();
        await page.waitForLoadState("networkidle");
        await expect.poll(async () => (await second.boundingBox())!.y).toBeLessThan((await first.boundingBox())!.y);
      }

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.reload();
      await page.waitForLoadState("networkidle");
      const column = first.locator("xpath=ancestor::section[1]");
      const header = column.locator("header");
      const headerTop = (await header.boundingBox())!.y;
      await first.hover();
      await page.mouse.wheel(0, 6000);
      await expect(last).toBeInViewport();
      expect((await header.boundingBox())!.y).toBeCloseTo(headerTop, 0);
      await page.screenshot({ path: testInfo.outputPath(`${board.route}-desktop-bottom.png`) });
    } finally {
      await pool.query(`DELETE FROM compass_dev.${board.table} WHERE id=ANY($1::uuid[])`, [ids]);
      await pool.end();
    }
  });
}
