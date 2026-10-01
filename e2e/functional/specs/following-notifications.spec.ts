import { test, expect } from "../fixtures/index";
import type { APIRequestContext, Page } from "@playwright/test";
import pg from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * Following and in-app notifications, slice 2 (ADR "Following and in-app
 * notifications"). Two real users act on one Task through the real surfaces:
 * the UI, the panel PATCH API, the comments API and MCP. Every notification
 * for the second user must arrive exactly once, never for the actor, and an
 * unfollow must survive the unfollower's own later comment.
 */
const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";
const B_EMAIL = "following-reviewer@localhost.dev";

type ToolResult = { isError?: boolean; structuredContent?: { ok: boolean; message: string; data: Record<string, unknown> } };

test("follow, notify exactly once, mark read, unfollow stays unfollowed, removed member sees nothing", async ({ page, base, browser, playwright }) => {
  test.setTimeout(240_000);
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") {
    throw new Error("Following tests require the dedicated local compass_e2e database");
  }
  const pool = new pg.Pool({ connectionString: url.toString() });
  const baseURL = test.info().project.use.baseURL as string;
  const query = `orgSlug=${ORG}&workspaceSlug=${WORKSPACE}`;
  const token = `cmp_${randomBytes(16).toString("hex")}`;
  let bContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let bUserId = "";
  let workspaceId = "";
  // A fresh context with no session cookie: MCP authenticates by bearer key only.
  const mcp = await playwright.request.newContext({ baseURL });

  async function unread(client: APIRequestContext) {
    const response = await client.get(`/api/notifications/unread?${query}`);
    return { status: response.status(), body: response.ok() ? await response.json() as { count: number; available: boolean } : null };
  }
  async function tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const response = await mcp.post("/api/mcp", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } },
    });
    expect(response.status()).toBe(200);
    const text = await response.text();
    const payload = text.startsWith("event:") || text.startsWith("data:")
      ? JSON.parse(text.split("\n").find((line) => line.startsWith("data:"))!.slice(5))
      : JSON.parse(text);
    expect(payload.error).toBeUndefined();
    return payload.result;
  }
  const bell = (p: Page, name: string | RegExp) => p.getByRole("link", { name });

  try {
    // ── Second user: a real dev-credentials login, then a workspace membership ─
    const login = await playwright.request.newContext({ baseURL });
    const csrf = await (await login.get("/api/auth/csrf")).json() as { csrfToken: string };
    const signedIn = await login.post("/api/auth/callback/dev-credentials", {
      form: { csrfToken: csrf.csrfToken, email: B_EMAIL, callbackUrl: `${baseURL}/dashboard` },
      maxRedirects: 0,
    });
    expect([200, 302]).toContain(signedIn.status());
    const bState = await login.storageState();
    bContext = await browser.newContext({ storageState: bState, baseURL });
    const bPage = await bContext.newPage();

    const { rows: [member] } = await pool.query<{ user_id: string; workspace_id: string }>(
      `WITH u AS (UPDATE "${S}".users SET name = 'Reviewer' WHERE email = $1 RETURNING id),
            w AS (SELECT w.id FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $2 AND w.slug = $3)
       SELECT (SELECT id FROM u) AS user_id, (SELECT id FROM w) AS workspace_id`, [B_EMAIL, ORG, WORKSPACE]);
    bUserId = member.user_id;
    workspaceId = member.workspace_id;
    expect(bUserId, "dev login must have created the second user").toBeTruthy();
    await pool.query(
      `INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, bUserId]);
    await pool.query(
      `INSERT INTO "${S}".api_keys (id, user_id, name, key_hash, key_prefix, purpose, created_at) VALUES (gen_random_uuid(), $1, 'following e2e', $2, $3, 'USER', NOW())`,
      [bUserId, createHash("sha256").update(token).digest("hex"), token.slice(4, 12)]);

    // ── A creates a Task in the UI and automatically follows it ───────────────
    await page.goto(`${base}/tasks`);
    const todo = page.locator('[data-task-column="TODO"]');
    await todo.getByRole("button", { name: /Add task/i }).click();
    const title = `Follow me ${randomUUID().slice(0, 6)}`;
    await page.getByLabel("Title").fill(title);
    await todo.getByRole("button", { name: "Add Task", exact: true }).click();
    const panel = page.locator('[data-slot="sheet-content"]');
    await todo.getByRole("button", { name: title }).click();
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await panel.getByRole("link", { name: "Open full page" }).click();
    await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
    const taskId = new URL(page.url()).pathname.split("/").at(-1)!;
    const aFollow = page.getByRole("button", { name: "Following" });
    await expect(aFollow, "the creator auto-follows what they create").toBeVisible({ timeout: 15_000 });
    await expect(aFollow).toHaveAttribute("aria-pressed", "true");

    // ── B sees Follow, follows manually, and it persists ──────────────────────
    await bPage.goto(`${base}/tasks/${taskId}`);
    const bFollow = bPage.getByRole("button", { name: "Follow", exact: true });
    await expect(bFollow).toBeVisible({ timeout: 30_000 });
    await expect(bPage.getByRole("link", { name: "Notifications" })).toBeVisible();
    await bFollow.click();
    await expect(bPage.getByRole("button", { name: "Following" })).toBeVisible();
    await bPage.reload();
    await expect(bPage.getByRole("button", { name: "Following" })).toBeVisible({ timeout: 30_000 });

    // ── UI/panel status change by A: exactly one notification for B, none for A
    const bClient = bPage.request;
    expect((await unread(bClient)).body?.count).toBe(0);
    const status = await page.request.patch(`/api/panels/entity/task/${taskId}?${query}`, { data: { field: "status", value: "DONE" } });
    expect(status.ok()).toBe(true);
    expect((await unread(bClient)).body?.count, "exactly one status notification").toBe(1);
    expect((await unread(page.request)).body?.count, "the actor is never notified").toBe(0);

    // ── Comment and reply by A ────────────────────────────────────────────────
    const root = await page.request.post("/api/comments", { data: { targetType: "TASK", targetId: taskId, body: "First thoughts" } });
    expect(root.ok()).toBe(true);
    const rootId = (await root.json()).id as string;
    expect((await unread(bClient)).body?.count).toBe(2);
    const reply = await page.request.post("/api/comments", { data: { targetType: "TASK", targetId: taskId, body: "A reply", parentId: rootId } });
    expect(reply.ok()).toBe(true);
    expect((await unread(bClient)).body?.count, "replies notify too").toBe(3);

    // ── Assignment (Tasks only) tells the assignee ────────────────────────────
    const assign = await page.request.patch(`/api/panels/entity/task/${taskId}?${query}`, { data: { field: "assigneeUserId", value: bUserId } });
    expect(assign.ok()).toBe(true);
    expect((await unread(bClient)).body?.count, "ASSIGNED reaches the assignee once").toBe(4);

    // ── MCP: B's own credential moves the status; A hears once, B hears nothing
    const aBefore = (await unread(page.request)).body!.count;
    const moved = await tool("move_task_status", { taskId, status: "IN_PROGRESS" });
    expect(moved.isError).not.toBe(true);
    expect((await unread(page.request)).body?.count, "an MCP change notifies the other follower exactly once").toBe(aBefore + 1);
    expect((await unread(bClient)).body?.count, "the MCP caller acting through their own key is the actor").toBe(4);

    // ── B's bell and inbox in the UI ──────────────────────────────────────────
    await bPage.goto(`${base}/okrs`);
    await expect(bell(bPage, "Notifications, 4 unread")).toBeVisible({ timeout: 30_000 });
    await bell(bPage, "Notifications, 4 unread").click();
    await bPage.waitForURL(/\/notifications$/);
    const group = bPage.locator('[data-slot="notification-group"]').filter({ hasText: title });
    await expect(group.getByRole("link", { name: title })).toBeVisible();
    await expect(group.getByText("Dev User changed status from Todo to Done")).toBeVisible();
    await expect(group.getByText("Dev User commented")).toBeVisible();
    await expect(group.getByText("Dev User replied to a comment")).toBeVisible();
    await expect(group.getByText("Dev User assigned this to you")).toBeVisible();
    await expect(group.getByText("4 new")).toBeVisible();

    // Docs screenshots, regenerated only on request: FOLLOWING_SCREENSHOTS=1.
    if (process.env.FOLLOWING_SCREENSHOTS) {
      const out = "public/screenshots/docs";
      await bPage.screenshot({ path: `${out}/following-inbox-desktop.png` });
      await page.screenshot({ path: `${out}/following-button-desktop.png` });
      await bPage.setViewportSize({ width: 390, height: 844 });
      await bPage.reload();
      await expect(bPage.getByText("4 new")).toBeVisible({ timeout: 30_000 });
      await bPage.screenshot({ path: `${out}/following-inbox-mobile.png` });
      await bPage.setViewportSize({ width: 1280, height: 720 });
      await bPage.reload();
      await expect(bPage.getByText("4 new")).toBeVisible({ timeout: 30_000 });
    }

    // MCP inbox parity: same four, newest first, unread count agrees.
    const listed = await tool("list_notifications", { workspaceId, unreadOnly: true });
    expect(listed.structuredContent?.ok).toBe(true);
    expect(listed.structuredContent?.data.unreadCount).toBe(4);
    expect((listed.structuredContent?.data.items as unknown[]).length).toBe(4);

    // ── Mark all read clears the bell and survives a reload ───────────────────
    await bPage.getByRole("button", { name: /Mark all read/ }).click();
    await expect(bPage.getByText("4 new")).toHaveCount(0);
    await bPage.reload();
    await expect(bell(bPage, "Notifications")).toBeVisible({ timeout: 30_000 });
    await expect(bPage.getByTestId("notification-count")).toHaveCount(0);
    expect((await unread(bClient)).body?.count).toBe(0);

    // ── Unfollow is remembered, even after B's own comment ────────────────────
    await bPage.goto(`${base}/tasks/${taskId}`);
    await bPage.getByRole("button", { name: "Following" }).click();
    await expect(bPage.getByRole("button", { name: "Follow", exact: true })).toBeVisible();
    expect((await page.request.post("/api/comments", { data: { targetType: "TASK", targetId: taskId, body: "Anyone there?" } })).ok()).toBe(true);
    expect((await unread(bClient)).body?.count, "an unfollowed subject sends nothing").toBe(0);
    expect((await bClient.post("/api/comments", { data: { targetType: "TASK", targetId: taskId, body: "Reviewer here" } })).ok()).toBe(true);
    await bPage.reload();
    await expect(bPage.getByRole("button", { name: "Follow", exact: true }), "commenting must not silently re-follow").toBeVisible({ timeout: 30_000 });
    expect((await tool("follow", { workspaceId, subjectType: "TASK", subjectId: taskId })).structuredContent?.ok).toBe(true);
    await bPage.reload();
    await expect(bPage.getByRole("button", { name: "Following" })).toBeVisible({ timeout: 30_000 });

    // ── A removed member sees nothing ─────────────────────────────────────────
    await pool.query(`DELETE FROM "${S}".workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, bUserId]);
    expect((await unread(bClient)).status).toBe(404);
    expect((await bClient.get(`/api/following?${query}&subjectType=TASK&subjectId=${taskId}`)).status()).toBe(404);
  } finally {
    await bContext?.close();
    await mcp.dispose();
    if (bUserId) {
      await pool.query(`DELETE FROM "${S}".api_keys WHERE user_id = $1`, [bUserId]);
      await pool.query(`DELETE FROM "${S}".workspace_members WHERE user_id = $1`, [bUserId]);
      await pool.query(`DELETE FROM "${S}".follows WHERE user_id = $1`, [bUserId]);
      await pool.query(`DELETE FROM "${S}".notifications WHERE recipient_user_id = $1`, [bUserId]);
    }
    await pool.end();
  }
});
