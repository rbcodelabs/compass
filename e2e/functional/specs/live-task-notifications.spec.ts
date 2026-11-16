import { test, expect } from "../fixtures/index";
import type { APIRequestContext } from "@playwright/test";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Live in-session & desktop browser notifications — Hybrid Option A + Option C
 * Studio Quiet top-right card stack (SOL-121 / TASK-176).
 *
 * Verifies end-to-end:
 * 1. Single `ASSIGNED` alert surfaces in `[data-testid="live-notification-card"]` at top-right
 *    with `TASK-x`, priority, status, actor avatar/name; clicking `Open in panel ↗` slides open
 *    the Task Detail Panel (`?detail=task:...`) while staying on `/okrs` and marks it read.
 * 2. Burst of multiple personal alerts (`ASSIGNED` + `@MENTIONED` comment quote) layers into
 *    Option C's 3D collapsible deck (`+1 more in stack · Expand`), expands on click showing both
 *    cards and the sanitized `@mention` quote (in both Light and Dark mode), and `Mark read`
 *    clears each card & decrements the bell badge live.
 * 3. Passive followed event (`STATUS_CHANGED`) updates User B's unread bell count on the ~20s
 *    poll WITHOUT surfacing a live card.
 * 4. Notifications inbox renders `Desktop alerts: Off` -> `On` -> `Off` with zero horizontal
 *    overflow at `1280x800` and `390x844`.
 */
const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";
const B_EMAIL = "live-notif-reviewer@localhost.dev";

test("live 20s poll surfaces top-right Hybrid A+C cards, opens Task panel in place, stacks bursts with @mention quote, and stays silent for STATUS_CHANGED", async ({
  page,
  base,
  browser,
  playwright,
}) => {
  test.setTimeout(240_000);
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") {
    throw new Error("Live notification E2E requires the dedicated local compass_e2e database");
  }

  const pool = new pg.Pool({ connectionString: url.toString() });
  const baseURL = test.info().project.use.baseURL as string;
  const query = `orgSlug=${ORG}&workspaceSlug=${WORKSPACE}`;
  const qaDir = path.resolve(process.cwd(), "test-results/qa-screenshots");
  fs.mkdirSync(qaDir, { recursive: true });

  let bContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let bUserId = "";
  let workspaceId = "";

  async function unread(client: APIRequestContext) {
    const response = await client.get(`/api/notifications/unread?${query}`);
    return {
      status: response.status(),
      body: response.ok() ? ((await response.json()) as { count: number; available: boolean }) : null,
    };
  }

  try {
    // ── Sign in User B and add to workspace ───────────────────────────────────
    const login = await playwright.request.newContext({ baseURL });
    const csrf = (await (await login.get("/api/auth/csrf")).json()) as { csrfToken: string };
    const signedIn = await login.post("/api/auth/callback/dev-credentials", {
      form: { csrfToken: csrf.csrfToken, email: B_EMAIL, callbackUrl: `${baseURL}/dashboard` },
      maxRedirects: 0,
    });
    expect([200, 302]).toContain(signedIn.status());
    const bState = await login.storageState();
    await login.dispose();

    const {
      rows: [member],
    } = await pool.query<{ user_id: string; workspace_id: string }>(
      `WITH u AS (UPDATE "${S}".users SET name = 'Live Reviewer' WHERE email = $1 RETURNING id),
            w AS (SELECT w.id FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $2 AND w.slug = $3)
       SELECT (SELECT id FROM u) AS user_id, (SELECT id FROM w) AS workspace_id`,
      [B_EMAIL, ORG, WORKSPACE],
    );
    bUserId = member.user_id;
    workspaceId = member.workspace_id;
    expect(bUserId).toBeTruthy();

    await pool.query(
      `INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW())
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, bUserId],
    );
    await pool.query(`DELETE FROM "${S}".notifications WHERE recipient_user_id = $1`, [bUserId]);
    await pool.query(`DELETE FROM "${S}".follows WHERE user_id = $1`, [bUserId]);

    const {
      rows: [solution],
    } = await pool.query<{ id: string; title: string }>(
      `SELECT id, title FROM "${S}".solutions WHERE workspace_id = $1 ORDER BY created_at LIMIT 1`,
      [workspaceId],
    );
    expect(solution, "seeded workspace provides a Solution for @mention testing").toBeTruthy();

    // ── User A creates three Tasks up front and sets priorities ───────────────
    await page.goto(`${base}/tasks`);
    const todo = page.locator('[data-task-column="TODO"]');
    const suffix = randomUUID().slice(0, 6);
    const singleTitle = `Verify OAuth token refresh ${suffix}`;
    const burstTitle = `Sign off on rollout postconditions ${suffix}`;
    const passiveTitle = `Track rollout metrics ${suffix}`;

    for (const title of [singleTitle, burstTitle, passiveTitle]) {
      await todo.getByRole("button", { name: /Add task/i }).click();
      await page.getByLabel("Title").fill(title);
      await todo.getByRole("button", { name: "Add Task", exact: true }).click();
      await expect(todo.getByRole("button", { name: title })).toBeVisible({ timeout: 15_000 });
    }

    const { rows: createdTasks } = await pool.query<{
      id: string;
      title: string;
      seq_prefix: string | null;
      seq_number: number | null;
    }>(
      `SELECT id, title, seq_prefix, seq_number FROM "${S}".tasks WHERE workspace_id = $1 AND title = ANY($2::text[])`,
      [workspaceId, [singleTitle, burstTitle, passiveTitle]],
    );
    const singleTask = createdTasks.find((t) => t.title === singleTitle)!;
    const burstTask = createdTasks.find((t) => t.title === burstTitle)!;
    const passiveTask = createdTasks.find((t) => t.title === passiveTitle)!;
    expect(singleTask?.id).toBeTruthy();
    expect(burstTask?.id).toBeTruthy();
    expect(passiveTask?.id).toBeTruthy();

    expect(
      (
        await page.request.patch(`/api/panels/entity/task/${singleTask.id}?${query}`, {
          data: { field: "priority", value: "HIGH" },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await page.request.patch(`/api/panels/entity/task/${burstTask.id}?${query}`, {
          data: { field: "priority", value: "URGENT" },
        })
      ).ok(),
    ).toBe(true);

    // Headless Linux Chromium reports Notification.permission === "denied" without an OS notification daemon;
    // install a spec-faithful Notification shim starting at "default" -> requestPermission() -> "granted".
    bContext = await browser.newContext({
      storageState: bState,
      baseURL,
      viewport: { width: 1280, height: 800 },
    });
    await bContext.addInitScript(() => {
      const KEY = "__e2e_notif_perm";
      class E2ENotification {
        title: string;
        options?: NotificationOptions;
        onclick: (() => void) | null = null;
        static get permission(): NotificationPermission {
          return (window.sessionStorage.getItem(KEY) as NotificationPermission | null) ?? "default";
        }
        static async requestPermission(): Promise<NotificationPermission> {
          window.sessionStorage.setItem(KEY, "granted");
          return "granted";
        }
        constructor(title: string, options?: NotificationOptions) {
          this.title = title;
          this.options = options;
        }
        close() {}
      }
      Object.defineProperty(window, "Notification", {
        configurable: true,
        writable: true,
        value: E2ENotification,
      });
    });
    const bPage = await bContext.newPage();
    const bClient = bPage.request;

    // User B follows passiveTask so status changes on it generate STATUS_CHANGED notifications
    const followRes = await bClient.put("/api/following", {
      data: { orgSlug: ORG, workspaceSlug: WORKSPACE, subjectType: "TASK", subjectId: passiveTask.id, following: true },
    });
    expect(followRes.ok()).toBe(true);
    expect((await unread(bClient)).body?.count).toBe(0);

    // ── 1. Single live ASSIGNED card at top-right + Open in panel ↗ ───────────
    await bPage.goto(`${base}/okrs`);
    await bPage.bringToFront();
    await expect(bPage.getByRole("link", { name: "Notifications" })).toBeVisible({ timeout: 30_000 });
    await expect(bPage.getByTestId("notification-count")).toHaveCount(0);
    await expect
      .poll(() => bPage.evaluate(() => document.visibilityState === "visible" && document.hasFocus()))
      .toBe(true);

    const assignSingle = await page.request.patch(`/api/panels/entity/task/${singleTask.id}?${query}`, {
      data: { field: "assigneeUserId", value: bUserId },
    });
    expect(assignSingle.ok()).toBe(true);

    const card = bPage.getByTestId("live-notification-card");
    await expect(card).toBeVisible({ timeout: 28_000 });
    // Hover stack so the 10s countdown pauses deterministically during assertions & screenshot capture
    await card.hover();

    if (singleTask.seq_number) {
      await expect(card).toContainText(`${singleTask.seq_prefix ?? "TASK"}-${singleTask.seq_number}`);
    }
    await expect(card).toContainText("Dev User");
    await expect(card).toContainText("assigned this to you");
    await expect(card).toContainText("High");
    await expect(card).toContainText("Todo");
    await expect(card).toContainText(singleTitle);
    await expect(card).toContainText("Auto-following");
    await expect(bPage.getByRole("link", { name: "Notifications, 1 unread" })).toBeVisible();
    expect(await bPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // Screenshot 1: Single Option A card on Desktop Light (1280x800)
    await bPage.screenshot({ path: path.join(qaDir, "01-single-card-desktop-light.png") });

    // Screenshot 5: Single Option A card on Mobile Light (390x844) below MobileHeader
    await bPage.setViewportSize({ width: 390, height: 844 });
    await expect(card).toBeVisible();
    await card.hover();
    expect(await bPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await bPage.screenshot({ path: path.join(qaDir, "05-single-card-mobile-light.png") });

    // Restore Desktop (1280x800) and click "Open in panel ↗"
    await bPage.setViewportSize({ width: 1280, height: 800 });
    await card.getByTestId("live-notification-open").click();

    // Stays on /okrs while sliding open the right-hand Task Detail Panel (?detail=task:<id>)
    await expect(bPage).toHaveURL(new RegExp(`/okrs\\?detail=task(%3A|:)${singleTask.id}`));
    const detailPanel = bPage.locator('[data-slot="sheet-content"]');
    await expect(detailPanel).toBeVisible({ timeout: 15_000 });
    await expect(detailPanel).toContainText(singleTitle, { timeout: 15_000 });
    await expect(card).toHaveCount(0);
    await expect(bPage.getByTestId("notification-count")).toHaveCount(0);
    await expect.poll(async () => (await unread(bClient)).body?.count).toBe(0);

    // Screenshot 4: Task Detail Panel slid open in place over /okrs (1280x800)
    await bPage.screenshot({ path: path.join(qaDir, "04-open-in-panel-desktop-light.png") });

    // Close panel via its Close panel button — User B never left /okrs!
    await detailPanel.getByRole("button", { name: "Close panel" }).click();
    await expect(detailPanel).toHaveCount(0);
    await expect(bPage.getByRole("link", { name: "Notifications" })).toBeVisible({ timeout: 15_000 });

    // ── 2. Burst of 2 personal alerts (ASSIGNED + @MENTIONED) -> 3D Deck + Dark Mode + Mark Read
    const assignBurst = await page.request.patch(`/api/panels/entity/task/${burstTask.id}?${query}`, {
      data: { field: "assigneeUserId", value: bUserId },
    });
    expect(assignBurst.ok()).toBe(true);

    const mentionBody = `@[Live Reviewer](mention:user:${bUserId}) should clicking Open in panel keep your scroll position on OKRs?`;
    const mentionPost = await page.request.post("/api/comments", {
      data: {
        targetType: "SOLUTION",
        targetId: solution.id,
        body: mentionBody,
      },
    });
    expect(mentionPost.ok()).toBe(true);

    const deckToggle = bPage.getByTestId("live-notification-deck-toggle");
    await expect(deckToggle).toBeVisible({ timeout: 28_000 });
    await bPage.getByTestId("live-notification-card").first().hover();
    await expect(deckToggle).toHaveText("+1 more in stack · Expand");
    await expect(bPage.getByRole("link", { name: "Notifications, 2 unread" })).toBeVisible();

    // Screenshot 2: Option C 3D collapsed burst deck on Desktop Light (1280x800)
    await bPage.screenshot({ path: path.join(qaDir, "02-burst-deck-collapsed-desktop-light.png") });

    // Expand stack -> both cards + @mention quote visible
    await deckToggle.click();
    await expect(deckToggle).toHaveText("Collapse stack");
    const expandedCards = bPage.getByTestId("live-notification-card");
    await expect(expandedCards).toHaveCount(2);
    await expect(bPage.getByTestId("live-notification-stack")).toContainText(
      "@Live Reviewer should clicking Open in panel keep your scroll position on OKRs?",
    );
    await expect(bPage.getByTestId("live-notification-stack")).toContainText(burstTitle);
    await expect(bPage.getByTestId("live-notification-stack")).toContainText("Urgent");

    // Switch to Dark mode to verify Studio Quiet dark tokens & capture Screenshot 3
    await bPage.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.dataset.theme = "dark";
      document.documentElement.style.colorScheme = "dark";
    });
    await expandedCards.first().hover();
    expect(await bPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await bPage.screenshot({ path: path.join(qaDir, "03-burst-deck-expanded-desktop-dark.png") });

    // Restore Light mode and verify `Mark read` clears each card & decrements the bell badge
    await bPage.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.dataset.theme = "light";
      document.documentElement.style.colorScheme = "light";
    });

    await expandedCards.first().getByTestId("live-notification-mark-read").click();
    await expect(expandedCards).toHaveCount(1);
    await expect(deckToggle).toHaveCount(0);
    await expect(bPage.getByRole("link", { name: "Notifications, 1 unread" })).toBeVisible({ timeout: 15_000 });

    await expandedCards.first().getByTestId("live-notification-mark-read").click();
    await expect(expandedCards).toHaveCount(0);
    await expect(bPage.getByRole("link", { name: "Notifications" })).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await unread(bClient)).body?.count).toBe(0);

    // ── 3. Passive STATUS_CHANGED updates bell on ~20s poll WITHOUT popping a card
    const statusPatch = await page.request.patch(`/api/panels/entity/task/${passiveTask.id}?${query}`, {
      data: { field: "status", value: "IN_PROGRESS" },
    });
    expect(statusPatch.ok()).toBe(true);

    await expect(bPage.getByRole("link", { name: "Notifications, 1 unread" })).toBeVisible({ timeout: 28_000 });
    await expect(bPage.getByTestId("live-notification-card")).toHaveCount(0);

    // ── 4. Notifications inbox: Desktop alerts toggle + responsive layout ─────
    await bPage.goto(`${base}/notifications`);
    await bPage.bringToFront();
    const desktopToggle = bPage.getByTestId("desktop-notifications-toggle");
    await expect(desktopToggle).toBeVisible({ timeout: 30_000 });
    await expect(desktopToggle).toHaveText("Desktop alerts: Off");
    await expect(desktopToggle).toHaveAttribute("aria-pressed", "false");

    await desktopToggle.click();
    await expect(desktopToggle).toHaveText("Desktop alerts: On");
    await expect(desktopToggle).toHaveAttribute("aria-pressed", "true");
    expect(await bPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await bPage.setViewportSize({ width: 390, height: 844 });
    await expect(desktopToggle).toBeVisible();
    expect(await bPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await bPage.setViewportSize({ width: 1280, height: 800 });
    await desktopToggle.click();
    await expect(desktopToggle).toHaveText("Desktop alerts: Off");
    await expect(desktopToggle).toHaveAttribute("aria-pressed", "false");
  } finally {
    await bContext?.close();
    if (bUserId) {
      await pool.query(`DELETE FROM "${S}".workspace_members WHERE user_id = $1`, [bUserId]);
      await pool.query(`DELETE FROM "${S}".follows WHERE user_id = $1`, [bUserId]);
      await pool.query(`DELETE FROM "${S}".notifications WHERE recipient_user_id = $1`, [bUserId]);
    }
    await pool.end();
  }
});
