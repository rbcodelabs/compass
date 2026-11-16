import { test, expect } from "../fixtures/index";
import type { APIRequestContext } from "@playwright/test";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Live in-session & desktop browser notifications (SOL-121 / TASK-176).
 * Verifies:
 * 1. Direct personal event (`ASSIGNED`) surfaces an actionable live toast on User B's
 *    active `/okrs` session via the ~20s poll without navigation or reload, updates
 *    the unread bell count live, and clicking "Open" marks it read and navigates to
 *    `/tasks/<id>`.
 * 2. Passive followed event (`STATUS_CHANGED`) updates User B's unread bell count
 *    on the ~20s poll WITHOUT popping a live toast.
 * 3. Notifications inbox renders the per-browser `Desktop alerts` toggle (`Off` -> `On` -> `Off`)
 *    with zero horizontal overflow at both Desktop (`1280x800`) and Mobile (`390x844`).
 */
const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";
const B_EMAIL = "live-notif-reviewer@localhost.dev";

test("live 20s poll surfaces actionable toast for ASSIGNED, updates bell silently for STATUS_CHANGED, and toggles desktop alerts cleanly", async ({
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

    // ── User A creates two Tasks up front ─────────────────────────────────────
    await page.goto(`${base}/tasks`);
    const todo = page.locator('[data-task-column="TODO"]');
    const suffix = randomUUID().slice(0, 6);
    const assignedTitle = `Review launch readiness ${suffix}`;
    const passiveTitle = `Track rollout metrics ${suffix}`;

    for (const title of [assignedTitle, passiveTitle]) {
      await todo.getByRole("button", { name: /Add task/i }).click();
      await page.getByLabel("Title").fill(title);
      await todo.getByRole("button", { name: "Add Task", exact: true }).click();
      await expect(todo.getByRole("button", { name: title })).toBeVisible({ timeout: 15_000 });
    }

    const { rows: createdTasks } = await pool.query<{ id: string; title: string }>(
      `SELECT id, title FROM "${S}".tasks WHERE workspace_id = $1 AND title = ANY($2::text[])`,
      [workspaceId, [assignedTitle, passiveTitle]],
    );
    const assignedTaskId = createdTasks.find((t) => t.title === assignedTitle)!.id;
    const passiveTaskId = createdTasks.find((t) => t.title === passiveTitle)!.id;
    expect(assignedTaskId).toBeTruthy();
    expect(passiveTaskId).toBeTruthy();

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

    // User B follows passiveTaskId so status changes on it generate STATUS_CHANGED notifications
    const followRes = await bClient.put("/api/following", {
      data: { orgSlug: ORG, workspaceSlug: WORKSPACE, subjectType: "TASK", subjectId: passiveTaskId, following: true },
    });
    expect(followRes.ok()).toBe(true);
    expect((await unread(bClient)).body?.count).toBe(0);

    // ── 1. User B sits on /okrs at 0 unread (without navigating or reloading) ─
    await bPage.goto(`${base}/okrs`);
    await bPage.bringToFront();
    await expect(bPage.getByRole("link", { name: "Notifications" })).toBeVisible({ timeout: 30_000 });
    await expect(bPage.getByTestId("notification-count")).toHaveCount(0);
    await expect
      .poll(() => bPage.evaluate(() => document.visibilityState === "visible" && document.hasFocus()))
      .toBe(true);

    // User A assigns `assignedTaskId` to User B via panel PATCH API
    const assignPatch = await page.request.patch(`/api/panels/entity/task/${assignedTaskId}?${query}`, {
      data: { field: "assigneeUserId", value: bUserId },
    });
    expect(assignPatch.ok()).toBe(true);

    // Wait up to 28s for the ~20s live poll to surface the toast & update the bell badge
    const toast = bPage.getByTestId("undo-toast");
    await expect(toast).toBeVisible({ timeout: 28_000 });
    await expect(toast).toContainText("Dev User assigned this to you");
    await expect(toast).toContainText(assignedTitle);
    await expect(bPage.getByRole("link", { name: "Notifications, 1 unread" })).toBeVisible();

    // Capture Desktop (1280x800) and Mobile (390x844) QA screenshots of the live toast
    await bPage.screenshot({ path: path.join(qaDir, "live-toast-desktop.png") });
    await bPage.setViewportSize({ width: 390, height: 844 });
    await expect(toast).toBeVisible();
    const mobileToastOverflow = await bPage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(mobileToastOverflow).toBe(true);
    await bPage.screenshot({ path: path.join(qaDir, "live-toast-mobile.png") });
    await bPage.setViewportSize({ width: 1280, height: 800 });

    // Click "Open" on the live toast -> navigates to /tasks/<assignedTaskId> & marks read
    await toast.getByRole("button", { name: "Open" }).click();
    await bPage.waitForURL(new RegExp(`/tasks/${assignedTaskId}$`), { timeout: 20_000 });
    await expect.poll(async () => (await unread(bClient)).body?.count).toBe(0);

    // ── 2. Passive STATUS_CHANGED updates bell on ~20s poll WITHOUT popping a toast
    await bPage.goto(`${base}/okrs`);
    await bPage.bringToFront();
    await expect(bPage.getByRole("link", { name: "Notifications" })).toBeVisible({ timeout: 30_000 });

    const statusPatch = await page.request.patch(`/api/panels/entity/task/${passiveTaskId}?${query}`, {
      data: { field: "status", value: "IN_PROGRESS" },
    });
    expect(statusPatch.ok()).toBe(true);

    // Wait for the ~20s live poll to update the bell badge to 1 unread
    await expect(bPage.getByRole("link", { name: "Notifications, 1 unread" })).toBeVisible({ timeout: 28_000 });
    await expect(bPage.getByTestId("undo-toast")).toHaveCount(0);

    // ── 3. Notifications inbox: Desktop alerts toggle + responsive layout ─────
    await bPage.goto(`${base}/notifications`);
    await bPage.bringToFront();
    const desktopToggle = bPage.getByTestId("desktop-notifications-toggle");
    await expect(desktopToggle).toBeVisible({ timeout: 30_000 });
    await expect(desktopToggle).toHaveText("Desktop alerts: Off");
    await expect(desktopToggle).toHaveAttribute("aria-pressed", "false");

    await desktopToggle.click();
    await expect(desktopToggle).toHaveText("Desktop alerts: On");
    await expect(desktopToggle).toHaveAttribute("aria-pressed", "true");

    // Verify zero horizontal overflow & capture Desktop inbox screenshot (1280x800)
    expect(await bPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await bPage.screenshot({ path: path.join(qaDir, "notifications-inbox-desktop.png") });

    // Verify zero horizontal overflow & capture Mobile inbox screenshot (390x844)
    await bPage.setViewportSize({ width: 390, height: 844 });
    await expect(desktopToggle).toBeVisible();
    expect(await bPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await bPage.screenshot({ path: path.join(qaDir, "notifications-inbox-mobile.png") });

    // Toggle back to Off
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
