/**
 * Doc comment @mentions that become Tasks.
 *
 * Drives the real Docs UI: select a passage, comment, type "@" to pick a person
 * or an agent, and post with the "Create task" row on. Then checks what the
 * people involved would see (task card, passage pin, notifications) and that the
 * Task -> Done / reopen sync resolves and reopens the thread.
 *
 * Users: A is the signed-in dev user (author), B a workspace member (assignee),
 * W a workspace member (watcher), D an org member with NO workspace access.
 * The agent is seeded straight into agents + agent_workspace_grants.
 */
import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import type { APIRequestContext, BrowserContext, Page, PlaywrightWorkerArgs } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";
const SHOTS = process.env.COMMENT_TASK_SHOTS_DIR;

test.describe("Doc comment @mention -> task", () => {
  test.describe.configure({ mode: "serial" });

  const suffix = randomUUID().slice(0, 6);
  const bEmail = `mention-b-${suffix}@localhost.dev`;
  const wEmail = `mention-w-${suffix}@localhost.dev`;
  const dEmail = `mention-d-${suffix}@localhost.dev`;
  const bName = `Quinn Mentionable ${suffix}`;
  const wName = `Wendy Watcher ${suffix}`;
  const dName = `Dana Outsider ${suffix}`;
  const agentName = `QA Agent ${suffix}`;
  const agentId = randomUUID();
  const query = `orgSlug=${ORG}&workspaceSlug=${WORKSPACE}`;

  let pool: pg.Pool;
  let workspaceId = "";
  let aUserId = "";
  let bUserId = "";
  let wUserId = "";
  let dUserId = "";
  const contexts: BrowserContext[] = [];
  const apis: APIRequestContext[] = [];
  let bApi: APIRequestContext;
  let wApi: APIRequestContext;

  async function shot(page: Page, name: string) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  }

  async function signIn(playwright: PlaywrightWorkerArgs["playwright"], baseURL: string, email: string) {
    const login = await playwright.request.newContext({ baseURL });
    apis.push(login);
    const csrf = (await (await login.get("/api/auth/csrf")).json()) as { csrfToken: string };
    const signedIn = await login.post("/api/auth/callback/dev-credentials", {
      form: { csrfToken: csrf.csrfToken, email, callbackUrl: `${baseURL}/dashboard` },
      maxRedirects: 0,
    });
    expect([200, 302]).toContain(signedIn.status());
    return login;
  }

  async function unread(client: APIRequestContext): Promise<number> {
    const response = await client.get(`/api/notifications/unread?${query}`);
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { count: number }).count;
  }

  /** New doc with one sentence, REVIEW selected, ready for the comment button. */
  async function openDocWithSelection(page: Page, base: string, title: string, word = "REVIEW") {
    await page.goto(`${base}/docs`);
    await page.waitForLoadState("networkidle");
    const previousDocUrl = page.url();
    await page.getByRole("button", { name: "New" }).click();
    await page.waitForURL((url) => url.href !== previousDocUrl && /\/docs\/[0-9a-f-]+$/.test(url.pathname), { timeout: 15_000 });
    const editor = page.locator(".ProseMirror");
    await expect(editor).toBeVisible({ timeout: 10_000 });
    const titleInput = page.getByPlaceholder("Untitled");
    await titleInput.fill(title);
    await titleInput.blur();
    await editor.click();
    await page.keyboard.type(`${word} the rollout checklist needs an owner and a rollback criterion`);
    await page.waitForTimeout(1800); // past the autosave debounce
    await page.keyboard.press("Home");
    for (let i = 0; i < word.length; i++) await page.keyboard.press("Shift+ArrowRight");
    await expect(page.getByTitle("Comment on selection")).toBeEnabled({ timeout: 10_000 });
    return new URL(page.url()).pathname.split("/").pop()!;
  }

  /** The Comments panel is a sheet unless pinned; close it so the editor and toolbar are reachable. */
  async function closeCommentsPanel(page: Page) {
    const panel = page.getByRole("complementary", { name: "Comments" });
    if (await panel.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden({ timeout: 10_000 });
    }
  }

  async function openCommentsPanel(page: Page) {
    await page.getByTitle("Comments").click();
    await expect(page.getByTestId("doc-comments-list")).toBeVisible({ timeout: 10_000 });
  }

  async function startComment(page: Page) {
    await page.getByTitle("Comment on selection").click();
    const editor = page.getByRole("textbox", { name: "Comment", exact: true });
    await expect(editor).toBeVisible({ timeout: 10_000 });
    return editor;
  }

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(120_000);
    pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
    const baseURL = test.info().project.use.baseURL as string;
    bApi = await signIn(playwright, baseURL, bEmail);
    wApi = await signIn(playwright, baseURL, wEmail);
    await signIn(playwright, baseURL, dEmail);
    const names: Record<string, string> = { [bEmail]: bName, [wEmail]: wName, [dEmail]: dName };
    for (const [email, name] of Object.entries(names)) {
      await pool.query(`UPDATE "${S}".users SET name = $1 WHERE email = $2`, [name, email]);
    }
    const idOf = async (email: string) => (await pool.query<{ id: string }>(`SELECT id FROM "${S}".users WHERE email = $1`, [email])).rows[0].id;
    [bUserId, wUserId, dUserId] = [await idOf(bEmail), await idOf(wEmail), await idOf(dEmail)];
    aUserId = await idOf("dev@localhost.dev");
    const { rows: [ws] } = await pool.query<{ id: string; organization_id: string }>(
      `SELECT w.id, w.organization_id FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $1 AND w.slug = $2`,
      [ORG, WORKSPACE],
    );
    workspaceId = ws.id;
    for (const userId of [bUserId, wUserId]) {
      await pool.query(
        `INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [workspaceId, userId],
      );
    }
    // D belongs to the org but has no workspace membership.
    await pool.query(
      `INSERT INTO "${S}".organization_members (id, organization_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [ws.organization_id, dUserId],
    );
    await pool.query(`INSERT INTO "${S}".agents (id, owner_user_id, name, description) VALUES ($1, $2, $3, 'Test plans, regression checks')`, [agentId, aUserId, agentName]);
    await pool.query(
      `INSERT INTO "${S}".agent_workspace_grants (agent_id, workspace_id, access, granted_by_user_id) VALUES ($1, $2, 'WRITE', $3)`,
      [agentId, workspaceId, aUserId],
    );
  });

  test.afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM "${S}".agent_workspace_grants WHERE agent_id = $1`, [agentId]).catch(() => undefined);
      await pool.query(`DELETE FROM "${S}".agents WHERE id = $1`, [agentId]).catch(() => undefined);
      await pool.end();
    }
    for (const context of contexts) await context.close();
    for (const api of apis) await api.dispose();
  });

  test("person: pick, task row, post, card + pin, notifications, Done resolves and reopen reopens the thread", async ({ page, base }) => {
    test.setTimeout(240_000);
    const docTitle = `Launch plan ${suffix}`;
    const docId = await openDocWithSelection(page, base, docTitle);

    // ── Frame 1: type "@" -> one grouped picker of people and agents ─────────
    const editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("Can you draft this by Friday? @Quinn");
    const picker = page.getByTestId("mention-picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByText("People", { exact: true })).toBeVisible();
    await expect(picker.getByTestId("mention-option")).toHaveCount(1);
    await expect(picker.getByTestId("mention-option")).toContainText(bName);
    // Agents sit in their own group with an Agent badge; clear the query to see it.
    for (let i = 0; i < "Quinn".length; i++) await page.keyboard.press("Backspace");
    await expect(picker.getByText("Agents", { exact: true })).toBeVisible();
    await expect(picker.getByTestId("mention-option").filter({ hasText: agentName })).toContainText("Agent");
    await shot(page, "frame-1-picker");
    await page.keyboard.type("Quinn");

    // Esc leaves a literal "@" and closes the picker; typing on re-opens it.
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    await expect(editor).toContainText("@Quinn");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("n");
    await expect(picker).toBeVisible();

    // ── Frame 2: select with the keyboard -> chip + "Create task" on ────────
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("mention-chip")).toHaveText(`@${bName}`);
    const toggle = page.getByTestId("create-task-toggle");
    await expect(toggle).toBeChecked();
    await expect(page.getByLabel("Task title")).toHaveValue("Can you draft this by Friday");
    await expect(page.getByRole("button", { name: "Comment & create task" })).toBeVisible();
    await page.getByLabel("Task title").fill("Draft rollout checklist and rollback criterion");
    await page.getByLabel("Due date").fill("2026-10-23");
    await page.getByLabel("Priority").selectOption("HIGH");
    await expect(page.getByText(`Links back to this passage in`)).toContainText(docTitle);
    await shot(page, "frame-2-create-task");

    // Unchecking is a plain mention: the label reverts and the fields go away.
    await toggle.click();
    await expect(page.getByRole("button", { name: "Comment", exact: true })).toBeVisible();
    await expect(page.getByTestId("task-fields")).toHaveCount(0);
    await toggle.click();
    await expect(page.getByRole("button", { name: "Comment & create task" })).toBeVisible();

    // Add a watcher: the second mention only follows.
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type("cc @Wendy");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("mention-roles")).toContainText("Assignee");
    await expect(page.getByTestId("mention-roles")).toContainText("Watcher");

    // ── Post ─────────────────────────────────────────────────────────────────
    await page.getByRole("button", { name: "Comment & create task" }).click();

    // ── Frame 3: card in the thread, pin on the passage ──────────────────────
    const card = page.getByTestId("comment-task-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("Draft rollout checklist and rollback criterion");
    await expect(card).toContainText(bName);
    await expect(card).toContainText("Oct 23");
    await expect(card).toContainText("High");
    await expect(card.getByTestId("task-card-status")).toHaveText("To do");
    await expect(card.getByTestId("open-task-link")).toHaveAttribute("href", /\/tasks\/[0-9a-f-]{36}$/);
    const pin = page.getByTestId("doc-comment-task-pin");
    await expect(pin).toHaveText("✓ 1");
    await expect(page.locator(".doc-comment-highlight-task")).toContainText("REVIEW");
    await expect(page.getByTestId("thread-auto-resolve-note")).toBeVisible();
    await expect(page.getByTestId("comment-mention").first()).toContainText(bName);
    await shot(page, "frame-3-posted");

    // ── What was stored ──────────────────────────────────────────────────────
    const { rows: tasks } = await pool.query(
      `SELECT t.id, t.title, t.status, t.priority, t.assignee_user_id, t.assignee_agent_id, t.due_date, t.seq_number
         FROM "${S}".tasks t JOIN "${S}".task_links l ON l.task_id = t.id
        WHERE l.linked_type = 'DOC' AND l.linked_id = $1`,
      [docId],
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Draft rollout checklist and rollback criterion", priority: "HIGH", assignee_user_id: bUserId, assignee_agent_id: null });
    expect(new Date(tasks[0].due_date).toISOString().slice(0, 10)).toBe("2026-10-23");
    const taskId = tasks[0].id as string;
    const { rows: links } = await pool.query(`SELECT linked_type, linked_id FROM "${S}".task_links WHERE task_id = $1 ORDER BY linked_type`, [taskId]);
    expect(links.map((l) => l.linked_type)).toEqual(["COMMENT", "DOC"]);
    const commentId = links.find((l) => l.linked_type === "COMMENT")!.linked_id as string;
    const { rows: [stored] } = await pool.query(`SELECT body FROM "${S}".doc_comments WHERE id = $1`, [commentId]);
    expect(stored.body).toContain(`](mention:user:${bUserId})`);
    expect(stored.body).toContain(`](mention:user:${wUserId})`);
    const { rows: mirror } = await pool.query(`SELECT status FROM "${S}".comments WHERE id = $1 AND target_type = 'DOC'`, [commentId]);
    expect(mirror).toEqual([{ status: "OPEN" }]);

    // ── Notifications: assignee told once (assigned), watcher told once ──────
    expect(await unread(bApi)).toBe(1);
    expect(await unread(wApi)).toBe(1);
    expect(await unread(page.request)).toBe(0);

    // ── Rename safety: the chip follows the id, not the stored label ─────────
    const renamed = `${bName} Renamed`;
    await pool.query(`UPDATE "${S}".users SET name = $1 WHERE id = $2`, [renamed, bUserId]);
    await page.reload();
    await openCommentsPanel(page);
    await expect(page.getByTestId("doc-comments-list").getByTestId("comment-mention").first()).toContainText(renamed, { timeout: 15_000 });
    await expect(page.getByTestId("comment-task-card")).toContainText(renamed);
    await pool.query(`UPDATE "${S}".users SET name = $1 WHERE id = $2`, [bName, bUserId]);

    // ── Sync: Done resolves the thread, reopening the task reopens it ────────
    const done = await page.request.patch(`/api/panels/entity/task/${taskId}?${query}`, { data: { field: "status", value: "DONE" } });
    expect(done.ok()).toBe(true);
    await expect.poll(async () => (await pool.query(`SELECT status FROM "${S}".doc_comments WHERE id = $1`, [commentId])).rows[0].status).toBe("RESOLVED");
    expect((await pool.query(`SELECT status FROM "${S}".comments WHERE id = $1`, [commentId])).rows[0].status, "the shared mirror follows").toBe("RESOLVED");
    await page.reload();
    await openCommentsPanel(page);
    await expect(page.getByTestId("doc-comment-thread")).toHaveCount(0);
    await expect(page.getByTestId("doc-comment-task-pin")).toHaveCount(0);

    // Marking Done again changes nothing (idempotent).
    await page.request.patch(`/api/panels/entity/task/${taskId}?${query}`, { data: { field: "status", value: "DONE" } });
    expect((await pool.query(`SELECT status FROM "${S}".doc_comments WHERE id = $1`, [commentId])).rows[0].status).toBe("RESOLVED");

    const reopen = await page.request.patch(`/api/panels/entity/task/${taskId}?${query}`, { data: { field: "status", value: "IN_PROGRESS" } });
    expect(reopen.ok()).toBe(true);
    await expect.poll(async () => (await pool.query(`SELECT status FROM "${S}".doc_comments WHERE id = $1`, [commentId])).rows[0].status).toBe("OPEN");
    await page.reload();
    await openCommentsPanel(page);
    await expect(page.getByTestId("doc-comment-thread")).toHaveCount(1);
    await expect(page.getByTestId("task-card-status")).toHaveText("In progress");
    await expect(page.getByTestId("doc-comment-task-pin")).toBeVisible();

    // A thread resolved by hand does not bounce into the task.
    await page.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(page.getByTestId("doc-comment-thread")).toHaveCount(0);
    expect((await pool.query(`SELECT status FROM "${S}".tasks WHERE id = $1`, [taskId])).rows[0].status).toBe("IN_PROGRESS");

    // The task side names the comment it came from instead of showing "(deleted)".
    const panel = await page.request.get(`/api/panels/entity/task/${taskId}?${query}`);
    expect(panel.ok()).toBe(true);
    expect(JSON.stringify(await panel.json())).toContain("Comment on");
  });

  test("edge cases: mention only, someone outside the workspace, an agent's first assignment", async ({ page, base }) => {
    test.setTimeout(240_000);
    const docId = await openDocWithSelection(page, base, `Edge cases ${suffix}`, "NOTE");
    const taskCount = async () => Number((await pool.query(`SELECT COUNT(*)::int AS n FROM "${S}".task_links WHERE linked_type = 'DOC' AND linked_id = $1`, [docId])).rows[0].n);

    // ── Mention only: toggle off -> a comment, no task, mentioned person told ─
    let editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("Heads up @Quinn");
    await page.keyboard.press("Enter");
    await page.getByTestId("create-task-toggle").click();
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByTestId("doc-comment-thread")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId("comment-task-card")).toHaveCount(0);
    expect(await taskCount()).toBe(0);
    const bBefore = await unread(bApi);
    expect(bBefore).toBeGreaterThanOrEqual(1);

    // ── Someone outside the workspace: warning, no task, "Mention only" ─────
    await closeCommentsPanel(page);
    await page.locator(".ProseMirror").click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    editor = await startComment(page);
    await editor.click();
    await page.keyboard.type(`@Dana`);
    const picker = page.getByTestId("mention-picker");
    await expect(picker.getByText("Not in this workspace")).toBeVisible();
    await page.keyboard.press("Enter");
    const alert = page.getByTestId("outside-workspace-alert");
    await expect(alert).toContainText(`${dName} isn’t in this workspace`);
    await expect(page.getByTestId("create-task-toggle")).toHaveCount(0);
    await expect(alert.getByTestId("invite-as-viewer")).toBeDisabled();
    await shot(page, "frame-4-outside-workspace");
    await alert.getByTestId("mention-only").click();
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type("can you take this?");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByTestId("doc-comment-thread")).toHaveCount(2, { timeout: 15_000 });
    expect(await taskCount()).toBe(0);

    // ── Agent: first assignment asks for scope, second does not ─────────────
    await closeCommentsPanel(page);
    await page.locator(".ProseMirror").click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("Pull baseline numbers @QA Agent");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("mention-chip")).toHaveText(`@${agentName}`);
    await page.getByRole("button", { name: "Comment & create task" }).click();
    const confirm = page.getByTestId("agent-scope-confirm");
    await expect(confirm).toContainText(`${agentName} will receive`);
    expect(await taskCount()).toBe(0);
    await shot(page, "frame-4-agent-scope");
    await page.getByTestId("confirm-agent-assign").click();
    const agentCard = page.getByTestId("comment-task-card").filter({ hasText: agentName });
    await expect(agentCard).toBeVisible({ timeout: 15_000 });
    await expect(agentCard).toHaveAttribute("data-agent", "true");
    await expect(agentCard.getByTestId("task-card-status")).toHaveText("Queued");
    await expect(agentCard).toContainText("Agent");
    await expect(page.locator(".doc-comment-pin-agent")).toHaveText("⚙ 1");
    const { rows: agentTasks } = await pool.query(
      `SELECT t.assignee_user_id, t.assignee_agent_id FROM "${S}".tasks t JOIN "${S}".task_links l ON l.task_id = t.id WHERE l.linked_type = 'DOC' AND l.linked_id = $1`,
      [docId],
    );
    expect(agentTasks).toEqual([{ assignee_user_id: null, assignee_agent_id: agentId }]);
    await shot(page, "frame-3-agent-card");

    await closeCommentsPanel(page);
    await page.locator(".ProseMirror").click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("And again @QA Agent");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByTestId("agent-scope-confirm")).toHaveCount(0);
  });
});
