/**
 * Adversarial QA for Doc comment @mentions -> tasks.
 *
 * Complements doc-comment-task-mentions.spec.ts (happy path). This file goes after what the happy path does not:
 * keyboard-only use, Esc layering, rapid typing, duplicate submits, body edited while a confirm is open, task
 * Done/reopen toggling across threads, deleting a thread that owns a task, an outsider (no workspace membership),
 * an agent with no/revoked/read-only grant, forged mention tokens sent straight to the server action, and a 390px phone.
 *
 * Findings are asserted where the behaviour is a requirement, and logged with test.info().annotations where the
 * behaviour is merely worth reporting.
 *
 * Originally written to fail until the QA findings were fixed (all fixed; the list is kept as the map of what each test covers):
 *   - "agent scope confirm ... edit the body while it is open"   composer left with no buttons
 *   - "task Done / reopen toggling ..."                          only when the concurrent-flip race hits (also covered by "race: ...")
 *   - "390px phone ..."                                          picker clipped in popover, task title and long-name chip overflow
 *   - "reply composer picker is not clipped ..." (x2)            upward picker clipped by the thread list
 *   - "race: concurrent task status flips ..."                   thread/task disagree after simultaneous flips
 */
import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import type { APIRequestContext, BrowserContext, Page, PlaywrightWorkerArgs, Request } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";
const SHOTS = process.env.COMMENT_TASK_SHOTS_DIR;

test.describe("Doc comment mentions: adversarial", () => {
  test.describe.configure({ mode: "default" });

  const suffix = randomUUID().slice(0, 6);
  const bEmail = `adv-b-${suffix}@localhost.dev`;
  const wEmail = `adv-w-${suffix}@localhost.dev`;
  const dEmail = `adv-d-${suffix}@localhost.dev`;
  const xEmail = `adv-x-${suffix}@localhost.dev`;
  const bName = `Rowan Bravo ${suffix}`;
  const wName = `Wren Watcher ${suffix}`;
  const dName = `Dale Outsider ${suffix}`;
  const agentName = `Adv Agent ${suffix}`;
  const readAgentName = `Adv ReadOnly ${suffix}`;
  const agentId = randomUUID();
  const readAgentId = randomUUID();
  const ghostAgentId = randomUUID(); // never granted
  const revokedAgentId = randomUUID(); // grant revoked
  const query = `orgSlug=${ORG}&workspaceSlug=${WORKSPACE}`;

  let pool: pg.Pool;
  let baseURL = "";
  let workspaceId = "";
  let aUserId = "";
  let bUserId = "";
  let wUserId = "";
  let dUserId = "";
  let xUserId = "";
  const seededDocIds: string[] = [];
  const contexts: BrowserContext[] = [];
  const apis: APIRequestContext[] = [];
  let bApi: APIRequestContext;
  let wApi: APIRequestContext;
  let dApi: APIRequestContext;
  /** Every console error/warning seen in any test, with the test that produced it. */
  const allConsole: string[] = [];

  async function shot(page: Page, name: string) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  }

  async function signIn(playwright: PlaywrightWorkerArgs["playwright"], email: string) {
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

  async function selectLeadingWord(page: Page, word: string) {
    await expect(async () => {
      await page.evaluate((w) => {
        const walker = document.createTreeWalker(document.querySelector(".ProseMirror p")!, NodeFilter.SHOW_TEXT);
        const first = walker.nextNode() as Text;
        const range = document.createRange();
        range.setStart(first, 0);
        let remaining = w.length;
        for (let node: Text | null = first; node; node = walker.nextNode() as Text | null) {
          if (node.length >= remaining) { range.setEnd(node, remaining); break; }
          remaining -= node.length;
        }
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      }, word);
      expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe(word);
      await expect(page.getByTitle("Comment on selection")).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
  }

  async function seedDoc(title: string, word: string, text?: string) {
    const docId = randomUUID();
    await pool.query(
      `INSERT INTO "${S}".docs (id, workspace_id, title, content, sort_order, doc_type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 9000, 'STANDARD', NOW(), NOW())`,
      [docId, workspaceId, title, text ?? `${word} the rollout checklist needs an owner and a rollback criterion`],
    );
    seededDocIds.push(docId);
    return docId;
  }

  async function openDocWithSelection(page: Page, base: string, title: string, word = "REVIEW") {
    const docId = await seedDoc(title, word);
    await page.goto(`${base}/docs/${docId}`);
    const editor = page.locator(".ProseMirror");
    await expect(editor).toContainText(word, { timeout: 60_000 });
    await editor.click();
    await selectLeadingWord(page, word);
    return docId;
  }

  const KEY_WARNING = 'unique "key" prop';
  /** Records every console error and warning plus uncaught errors; returns the non-noise errors (React key warning excluded: tracked by the isolation test). */
  function watchConsole(page: Page, label: string): string[] {
    const errors: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "error" || message.type() === "warning") allConsole.push(`[${label}] ${message.type()}: ${text.slice(0, 1500)}`);
      if (message.type() === "error" && !text.startsWith("Failed to load resource") && !text.includes(KEY_WARNING)) errors.push(text);
    });
    page.on("pageerror", (error) => { allConsole.push(`[${label}] pageerror: ${error.message}`); errors.push(error.message); });
    return errors;
  }

  const mark = (label: string) => allConsole.push(`### MARK ${label}`);

  /** Append a finding to test-results/findings.log (annotations are not printed by the dot reporter). */
  function finding(topic: string, detail: string) {
    fs.mkdirSync("test-results", { recursive: true });
    fs.appendFileSync("test-results/findings.log", `FINDING ${topic}: ${detail}\n`);
  }

  async function closeCommentsPanel(page: Page) {
    const overlay = page.locator('[data-slot="sheet-overlay"]');
    if ((await overlay.count()) > 0) {
      await page.keyboard.press("Escape");
      await expect(overlay).toHaveCount(0, { timeout: 10_000 });
    }
  }

  async function openCommentsPanel(page: Page) {
    if (await page.getByTestId("doc-comments-list").isVisible().catch(() => false)) return;
    await page.getByTitle("Comments", { exact: true }).click();
    await expect(page.getByTestId("doc-comments-list")).toBeVisible({ timeout: 10_000 });
  }

  async function startComment(page: Page) {
    await page.getByTitle("Comment on selection").click();
    const editor = page.getByRole("textbox", { name: "Comment", exact: true });
    await expect(editor).toBeVisible({ timeout: 10_000 });
    return editor;
  }

  async function dockPanel(page: Page) {
    await page.context().addCookies([{ name: "compass_panel_docsComments", value: "1:440", url: baseURL }]);
  }

  const taskRows = async (docId: string) =>
    (await pool.query(
      `SELECT t.id, t.title, t.status, t.assignee_user_id, t.assignee_agent_id
         FROM "${S}".tasks t JOIN "${S}".task_links l ON l.task_id = t.id
        WHERE l.linked_type = 'DOC' AND l.linked_id = $1 ORDER BY t.created_at`,
      [docId],
    )).rows as Array<{ id: string; title: string; status: string; assignee_user_id: string | null; assignee_agent_id: string | null }>;

  const commentIdsOf = async (docId: string) =>
    (await pool.query(`SELECT id, parent_id, status FROM "${S}".doc_comments WHERE doc_id = $1 ORDER BY created_at`, [docId])).rows as Array<{ id: string; parent_id: string | null; status: string }>;

  async function setTaskStatus(page: Page, taskId: string, status: string) {
    const response = await page.request.patch(`/api/panels/entity/task/${taskId}?${query}`, { data: { field: "status", value: status } });
    expect(response.ok(), `PATCH task status ${status}`).toBe(true);
  }

  const threadStatus = async (commentId: string) => (await pool.query(`SELECT status FROM "${S}".doc_comments WHERE id = $1`, [commentId])).rows[0]?.status as string | undefined;

  /** Capture the Next server-action request the composer sends so it can be replayed with a hostile body. */
  function captureAction(page: Page): { get: () => { url: string; headers: Record<string, string>; args: unknown[] } | null } {
    let captured: { url: string; headers: Record<string, string>; args: unknown[] } | null = null;
    page.on("request", (request: Request) => {
      const headers = request.headers();
      if (request.method() === "POST" && headers["next-action"] && request.postData()?.includes("anchorText")) {
        try {
          captured = { url: request.url(), headers, args: JSON.parse(request.postData()!) as unknown[] };
        } catch { /* not the action we want */ }
      }
    });
    return { get: () => captured };
  }

  async function replay(client: APIRequestContext, cap: { url: string; headers: Record<string, string>; args: unknown[] }, input: Record<string, unknown>) {
    const headers = { ...cap.headers };
    delete headers["content-length"];
    delete headers["host"];
    delete headers["cookie"];
    // The browser's React debug-channel / request id would make the dev server stream debug chunks into the live page.
    for (const name of Object.keys(headers)) if (/debug|request-id/i.test(name)) delete headers[name];
    const args = [{ ...(cap.args[0] as Record<string, unknown>), ...input }, ...cap.args.slice(1)];
    const response = await client.post(cap.url, { headers, data: JSON.stringify(args), maxRedirects: 0 });
    const text = await response.text();
    const error = /"error":"([A-Z_]+)"/.exec(text)?.[1] ?? null;
    return { status: response.status(), ok: /"ok":true/.test(text), error, text: text.slice(0, 400) };
  }

  const token = (kind: "user" | "agent", id: string, label: string) => `@[${label}](mention:${kind}:${id})`;

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(120_000);
    pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
    baseURL = test.info().project.use.baseURL as string;
    bApi = await signIn(playwright, bEmail);
    wApi = await signIn(playwright, wEmail);
    dApi = await signIn(playwright, dEmail);
    await signIn(playwright, xEmail);
    const names: Record<string, string> = { [bEmail]: bName, [wEmail]: wName, [dEmail]: dName };
    for (const [email, name] of Object.entries(names)) await pool.query(`UPDATE "${S}".users SET name = $1 WHERE email = $2`, [name, email]);
    const idOf = async (email: string) => (await pool.query<{ id: string }>(`SELECT id FROM "${S}".users WHERE email = $1`, [email])).rows[0].id;
    [bUserId, wUserId, dUserId, xUserId] = [await idOf(bEmail), await idOf(wEmail), await idOf(dEmail), await idOf(xEmail)];
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
    await pool.query(
      `INSERT INTO "${S}".organization_members (id, organization_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [ws.organization_id, dUserId],
    );
    for (const [id, name, grant, revoked] of [
      [agentId, agentName, "WRITE", false],
      [readAgentId, readAgentName, "READ", false],
      [revokedAgentId, `Adv Revoked ${suffix}`, "WRITE", true],
    ] as const) {
      await pool.query(`INSERT INTO "${S}".agents (id, owner_user_id, name, description) VALUES ($1, $2, $3, 'adversarial agent')`, [id, aUserId, name]);
      await pool.query(
        `INSERT INTO "${S}".agent_workspace_grants (agent_id, workspace_id, access, granted_by_user_id, revoked_at) VALUES ($1, $2, $3, $4, ${revoked ? "NOW()" : "NULL"})`,
        [id, workspaceId, grant, aUserId],
      );
    }
    await pool.query(`INSERT INTO "${S}".agents (id, owner_user_id, name, description) VALUES ($1, $2, $3, 'no grant at all')`, [ghostAgentId, aUserId, `Adv Ghost ${suffix}`]);
  });

  test.afterAll(async () => {
    if (pool) {
      for (const docId of seededDocIds) {
        await pool.query(`DELETE FROM "${S}".tasks WHERE id IN (SELECT task_id FROM "${S}".task_links WHERE linked_type = 'DOC' AND linked_id = $1)`, [docId]).catch(() => undefined);
        await pool.query(`DELETE FROM "${S}".task_links WHERE linked_type = 'DOC' AND linked_id = $1`, [docId]).catch(() => undefined);
      }
      for (const id of [agentId, readAgentId, revokedAgentId, ghostAgentId]) {
        await pool.query(`DELETE FROM "${S}".agent_workspace_grants WHERE agent_id = $1`, [id]).catch(() => undefined);
        await pool.query(`DELETE FROM "${S}".agents WHERE id = $1`, [id]).catch(() => undefined);
      }
      await pool.end();
    }
    for (const context of contexts) await context.close();
    for (const api of apis) await api.dispose();
    fs.mkdirSync("test-results", { recursive: true });
    fs.appendFileSync("test-results/adversarial-console.log", allConsole.join("\n---\n") + "\n---\n");
  });

  // ─────────────────────────────────────────────────────────────────────────
  test("keyboard only: arrows wrap, Tab selects, Backspace removes the chip, Esc layers, Space toggles, Ctrl+Enter posts", async ({ page, base }) => {
    test.setTimeout(240_000);
    const errors = watchConsole(page, "keyboard");
    await dockPanel(page);
    const docId = await openDocWithSelection(page, base, `Keyboard ${suffix}`, "ALPHA");

    // Open the composer from the keyboard (focus the toolbar button, press Enter).
    await page.getByTitle("Comment on selection").focus();
    await page.keyboard.press("Enter");
    const editor = page.getByRole("textbox", { name: "Comment", exact: true });
    await expect(editor).toBeVisible();
    await expect(editor).toBeFocused(); // autoFocus: the first key typed lands in the composer

    // "@" alone opens the full grouped list; ArrowUp from the first option wraps to the last.
    await page.keyboard.type("Please look @");
    const picker = page.getByTestId("mention-picker");
    await expect(picker).toBeVisible();
    const options = picker.getByTestId("mention-option");
    const total = await options.count();
    expect(total).toBeGreaterThanOrEqual(4);
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowUp");
    await expect(options.nth(total - 1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    // aria-activedescendant points at the highlighted option (screen reader contract).
    const activeId = await editor.getAttribute("aria-activedescendant");
    expect(activeId, "aria-activedescendant set while picker open").toBeTruthy();
    expect(await options.first().getAttribute("id")).toBe(activeId);

    // Narrow with the keyboard then Tab to select.
    for (const ch of "Rowan") await page.keyboard.press(ch === "R" ? "Shift+R" : ch);
    await expect(options).toHaveCount(1);
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("mention-chip")).toHaveText(`@${bName}`);
    await expect(picker).toBeHidden();
    await expect(editor).toBeFocused();

    // Backspace x2 (trailing space, then the chip) removes the whole chip and the task box with it.
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(page.getByTestId("mention-chip")).toHaveCount(0);
    await expect(page.getByTestId("comment-task-box")).toHaveCount(0);

    // Esc layering: first Esc closes only the picker, second Esc cancels the whole composer.
    await page.keyboard.type("@");
    await expect(picker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    await expect(page.getByTestId("new-comment-popover"), "first Esc must only close the picker").toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("new-comment-popover"), "second Esc cancels the composer").toBeHidden();

    // Reopen and finish the whole thing from the keyboard.
    await selectLeadingWord(page, "ALPHA");
    await page.getByTitle("Comment on selection").focus();
    await page.keyboard.press("Enter");
    await expect(editor).toBeFocused();
    await page.keyboard.type("First line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second line @Rowan");
    await page.keyboard.press("Enter"); // picker open: selects, does not add a line break
    await expect(page.getByTestId("mention-chip")).toHaveCount(1);
    expect(await editor.evaluate((el) => (el.textContent ?? "").split("\n").length - 1), "one line break (Shift+Enter), none added by the picker's Enter").toBe(1);

    // Tab (picker closed) walks to the Create task switch; Space turns it off and on.
    await page.keyboard.press("Tab");
    const toggle = page.getByTestId("create-task-toggle");
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Space");
    await expect(toggle).not.toBeChecked();
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();

    // Ctrl+Enter from the editor posts with the task.
    await editor.focus();
    await page.keyboard.press("Control+Enter");
    await expect(page.getByTestId("comment-task-card")).toBeVisible({ timeout: 20_000 });
    const rows = await taskRows(docId);
    expect(rows).toHaveLength(1);
    expect(rows[0].assignee_user_id).toBe(bUserId);
    expect(rows[0].title, "title is built from the text, line break collapsed").toBe("First line second line");
    expect(errors).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  test("rapid typing, paste, email-like text, many mentions, duplicates and double submit", async ({ page, base }) => {
    test.setTimeout(240_000);
    const errors = watchConsole(page, "rapid");
    await dockPanel(page);
    const docId = await openDocWithSelection(page, base, `Rapid ${suffix}`, "BRAVO");
    const editor = await startComment(page);
    await editor.click();
    const picker = page.getByTestId("mention-picker");

    // No picker for an email address or a mid-word "@".
    await page.keyboard.type("write to qa@example.com and x@y ");
    await expect(picker).toBeHidden();

    // Instant typing (no delay) straight into a selection with Enter, then another, then a duplicate of the first.
    await page.keyboard.type(`go @Rowan`, { delay: 0 });
    await page.keyboard.press("Enter");
    await page.keyboard.type(`@Wren`, { delay: 0 });
    await page.keyboard.press("Enter");
    await page.keyboard.type(`@Adv Agent`, { delay: 0 });
    await page.keyboard.press("Enter");
    await page.keyboard.type(`@Rowan`, { delay: 0 });
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("mention-chip")).toHaveCount(4);
    // Roles: duplicates collapse, first is assignee, the agent is a watcher (no scope confirm for a watcher).
    const roles = page.getByTestId("mention-roles");
    await expect(roles.getByText("Assignee", { exact: true })).toHaveCount(1);
    await expect(roles.getByText("Watcher", { exact: true })).toHaveCount(2);
    await expect(roles.locator(".mention-chip")).toHaveCount(3);

    // Promote the agent to assignee: now the scope step applies.
    await roles.getByRole("button", { name: "Make assignee" }).last().click();

    // Multi-line paste keeps the text, drops any markup, and does not open the picker.
    await editor.click();
    await page.keyboard.press("End");
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="doc-comment-editor"]') as HTMLElement;
      el.focus();
      const data = new DataTransfer();
      data.setData("text/plain", "pasted <b>bold</b>\nsecond @ line");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(editor).toContainText("pasted <b>bold</b>");
    expect(await editor.evaluate((el) => el.querySelectorAll("b").length), "pasted HTML stays text").toBe(0);

    // Double-click the submit button: one comment, one confirm.
    await page.getByRole("button", { name: "Comment & create task" }).dblclick();
    const confirm = page.getByTestId("agent-scope-confirm");
    await expect(confirm).toBeVisible();
    await page.getByTestId("confirm-agent-assign").dblclick();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(1, { timeout: 20_000 });
    await page.waitForTimeout(1500);
    expect((await taskRows(docId)).length, "double submit makes exactly one task").toBe(1);
    expect((await commentIdsOf(docId)).length, "double submit makes exactly one comment").toBe(1);
    const [row] = await taskRows(docId);
    expect(row.assignee_agent_id).toBe(agentId);
    // Rowan (first mention, now only a watcher) and Wren are told once each; the agent gets nothing.
    expect(await unread(bApi)).toBeGreaterThanOrEqual(1);
    expect(await unread(wApi)).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  test("agent scope confirm: edit the body while it is open, read-only grant copy, Cancel", async ({ page, base }) => {
    test.setTimeout(240_000);
    const errors = watchConsole(page, "scope");
    await dockPanel(page);
    await openDocWithSelection(page, base, `Scope ${suffix}`, "CHARLIE");
    const editor = await startComment(page);
    await editor.click();
    await page.keyboard.type(`do it @Adv ReadOnly`);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    const confirm = page.getByTestId("agent-scope-confirm");
    await expect(confirm).toContainText("read-only");
    await expect(confirm).toContainText(readAgentName);

    // Is the editor still editable behind the confirm? Delete the chip while the confirm is up.
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    const chipCount = await page.getByTestId("mention-chip").count();
    const confirmStillThere = await confirm.isVisible();
    const submitStillThere = await page.getByTestId("doc-comment-composer").getByRole("button", { name: "Comment", exact: true }).isVisible().catch(() => false);
    const cancelStillThere = await page.getByRole("button", { name: "Cancel" }).first().isVisible().catch(() => false);
    finding("finding: edit body during scope confirm", `chips=${chipCount} confirmVisible=${confirmStillThere} submitVisible=${submitStillThere} cancelVisible=${cancelStillThere}`
    );
    await shot(page, "adv-scope-edit-body");
    // The composer must always offer a way forward: either the confirm (with Cancel) or the normal buttons.
    expect(confirmStillThere || submitStillThere, "composer stuck: no confirm and no submit button after the chip was deleted during the scope step").toBe(true);

    expect(errors).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  test("task Done / reopen toggling, two tasks in one thread, manual resolve, delete the thread, member removed, agent renamed", async ({ page, base }) => {
    test.setTimeout(300_000);
    const errors = watchConsole(page, "lifecycle");
    await dockPanel(page);
    const docId = await openDocWithSelection(page, base, `Lifecycle ${suffix}`, "DELTA");
    let editor = await startComment(page);
    await editor.click();
    await page.keyboard.type(`root task @Rowan`);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(1, { timeout: 20_000 });

    // A reply in the same thread that makes a second task (assigned to Wren).
    const thread = page.getByTestId("doc-comment-thread").first();
    const reply = thread.getByRole("textbox", { name: "Reply", exact: true });
    await reply.click();
    await page.keyboard.type(`and this one @Wren`);
    await page.keyboard.press("Enter");
    await expect(thread.getByTestId("mention-picker")).toBeHidden();
    await thread.getByRole("button", { name: "Comment & create task" }).click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(2, { timeout: 20_000 });

    const tasks = await taskRows(docId);
    expect(tasks).toHaveLength(2);
    const [t1, t2] = tasks;
    const comments = await commentIdsOf(docId);
    const rootId = comments.find((c) => c.parent_id === null)!.id;

    // Done on ONE of two tasks must not resolve the thread; Done on both must.
    await setTaskStatus(page, t1.id, "DONE");
    await page.waitForTimeout(800);
    expect(await threadStatus(rootId), "one of two tasks Done: thread stays open").toBe("OPEN");
    await setTaskStatus(page, t2.id, "DONE");
    await expect.poll(() => threadStatus(rootId)).toBe("RESOLVED");

    // Toggle storm: reopen, Done, Todo, Done, Cancelled, back to In progress.
    const expectations: Array<[string, string]> = [
      [t2.id + ":IN_PROGRESS", "OPEN"],
      [t2.id + ":DONE", "RESOLVED"],
      [t2.id + ":TODO", "OPEN"],
      [t2.id + ":DONE", "RESOLVED"],
      [t2.id + ":CANCELLED", "RESOLVED"], // DONE -> CANCELLED leaves it as it was
      [t2.id + ":IN_PROGRESS", "RESOLVED"], // CANCELLED -> live: not coming from DONE, so no reopen
    ];
    for (const [step, expected] of expectations) {
      const [id, status] = step.split(":");
      await setTaskStatus(page, id, status);
      await page.waitForTimeout(500);
      expect(await threadStatus(rootId), `after ${status}`).toBe(expected);
    }
    // Rapid concurrent flips converge to the final state.
    await Promise.all([
      setTaskStatus(page, t2.id, "DONE"), setTaskStatus(page, t2.id, "TODO"), setTaskStatus(page, t2.id, "DONE"),
    ]);
    await page.waitForTimeout(1500);
    const finalTask = (await pool.query(`SELECT status FROM "${S}".tasks WHERE id = $1`, [t2.id])).rows[0].status as string;
    const finalThread = await threadStatus(rootId);
    finding("finding: concurrent flips", `task=${finalTask} thread=${finalThread}` );
    expect(finalThread === "RESOLVED", `task ${finalTask} but thread ${finalThread}: thread and task disagree after concurrent flips`).toBe(finalTask === "DONE" || t1.status === "DONE" && finalTask === "DONE");

    // Manual resolve then the task reopens (DONE -> TODO) the thread: is that wanted? Record it.
    await setTaskStatus(page, t2.id, "DONE");
    await expect.poll(() => threadStatus(rootId)).toBe("RESOLVED");

    // UI reflects the resolved thread after reload, and the card status text matches.
    await page.reload();
    await openCommentsPanel(page);
    await expect(page.getByTestId("doc-comment-thread")).toHaveCount(0);
    await page.getByRole("button", { name: /Show resolved/ }).click();
    await expect(page.getByTestId("doc-comment-thread")).toHaveCount(1);
    await expect(page.getByTestId("task-card-status").first()).toHaveText("Done");

    // Reopen via the task; delete the whole thread from the UI while the tasks are live.
    await setTaskStatus(page, t1.id, "IN_PROGRESS");
    await page.reload();
    await openCommentsPanel(page);
    const live = page.getByTestId("doc-comment-thread");
    await expect(live).toHaveCount(1);
    await live.getByTitle("Delete thread").click();
    await expect(live).toHaveCount(0, { timeout: 10_000 });
    const afterDelete = await taskRows(docId);
    const links = (await pool.query(`SELECT COUNT(*)::int AS n FROM "${S}".task_links WHERE linked_type = 'COMMENT' AND task_id = ANY($1)`, [[t1.id, t2.id]])).rows[0].n as number;
    finding("finding: delete thread with live tasks", `tasks still exist=${afterDelete.length}, comment links left=${links}, statuses=${afterDelete.map((t) => t.status).join(",")}` );
    expect(links, "no dangling COMMENT links after deleting the thread").toBe(0);
    await page.reload();
    await expect(page.locator(".ProseMirror")).toContainText("DELTA");
    // Setting the (now orphan) task Done must not throw.
    await setTaskStatus(page, t1.id, "DONE");
    await setTaskStatus(page, t1.id, "TODO");

    // Member removed and agent renamed after the fact: the card and chips must still render.
    await page.getByRole("button", { name: /Show resolved/ }).waitFor({ state: "hidden", timeout: 1000 }).catch(() => undefined);
    const doc2 = await openDocWithSelection(page, base, `Lifecycle2 ${suffix}`, "ECHO");
    editor = await startComment(page);
    await editor.click();
    await page.keyboard.type(`rename check @Adv Agent`);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await page.getByTestId("confirm-agent-assign").click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(1, { timeout: 20_000 });
    await pool.query(`UPDATE "${S}".agents SET name = $1 WHERE id = $2`, [`${agentName} RENAMED`, agentId]);
    await pool.query(`DELETE FROM "${S}".workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, wUserId]);
    await page.reload();
    await openCommentsPanel(page);
    await expect(page.getByTestId("comment-task-card")).toContainText("RENAMED");
    await expect(page.getByTestId("doc-comments-list").getByTestId("comment-mention").first()).toContainText("RENAMED");
    await pool.query(`UPDATE "${S}".agents SET name = $1 WHERE id = $2`, [agentName, agentId]);
    await pool.query(
      `INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, wUserId],
    );
    expect(await taskRows(doc2)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  test("assignee removed from the workspace after a task was assigned: card still renders", async ({ page, base }) => {
    test.setTimeout(240_000);
    const errors = watchConsole(page, "removed-assignee");
    await dockPanel(page);
    const docId = await openDocWithSelection(page, base, `Removed ${suffix}`, "FOXTROT");
    const editor = await startComment(page);
    await editor.click();
    await page.keyboard.type(`please @Wren`);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(1, { timeout: 20_000 });
    await pool.query(`DELETE FROM "${S}".workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, wUserId]);
    try {
      await page.reload();
      await openCommentsPanel(page);
      const card = page.getByTestId("comment-task-card");
      await expect(card).toBeVisible();
      const text = (await card.innerText()).replace(/\s+/g, " ");
      finding("finding: card for removed assignee", text );
      await expect(page.getByTestId("doc-comments-list").getByTestId("comment-mention").first()).toBeVisible();
    } finally {
      await pool.query(
        `INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [workspaceId, wUserId],
      );
    }
    expect((await taskRows(docId)).length).toBe(1);
    expect(errors).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  test("permissions: outsider, no-grant / revoked agent, forged tokens straight at the server action", async ({ page, base, browser, playwright }) => {
    test.setTimeout(300_000);
    const errors = watchConsole(page, "permissions");
    await dockPanel(page);
    const docId = await openDocWithSelection(page, base, `Perms ${suffix}`, "GOLF");
    const cap = captureAction(page);
    const editor = await startComment(page);
    await editor.click();
    await page.keyboard.type(`seed comment @Rowan`);
    await page.keyboard.press("Enter");
    await page.getByTestId("create-task-toggle").click(); // plain mention: this just gives us a genuine request to replay
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByTestId("doc-comment-thread")).toHaveCount(1, { timeout: 20_000 });
    const captured = cap.get();
    expect(captured, "captured the addDocCommentWithTask request").not.toBeNull();
    // Replays go through their own request context (same cookies as the author) so they cannot interact with the page.
    const author = await playwright.request.newContext({ baseURL, storageState: await page.context().storageState() });
    apis.push(author);
    const baseInput = {
      docId, anchorText: "GOLF", anchorStart: 1, anchorEnd: 5, anchorPrefix: "", anchorSuffix: " the rollout",
    };

    // The picker never offers an ungranted or revoked agent.
    await closeCommentsPanel(page);
    await page.locator(".ProseMirror").click();
    await selectLeadingWord(page, "GOLF");
    const editor2 = await startComment(page);
    await editor2.click();
    await page.keyboard.type("@Adv");
    const names = await page.getByTestId("mention-option").evaluateAll((els) => els.map((el) => el.getAttribute("data-mention-name")));
    expect(names).toContain(agentName);
    expect(names).toContain(readAgentName);
    expect(names.some((n) => n?.includes("Ghost")), "ungranted agent offered").toBe(false);
    expect(names.some((n) => n?.includes("Revoked")), "revoked agent offered").toBe(false);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    mark("start forged replays");
    // Server-side: assigning a task to agents that have no live grant is refused.
    for (const [label, id] of [["ghost", ghostAgentId], ["revoked", revokedAgentId]] as const) {
      const result = await replay(author, captured!, {
        ...baseInput,
        body: `${token("agent", id, label)} please`,
        task: { title: "forged agent task", priority: "MEDIUM", dueDate: null },
        agentScopeConfirmed: true,
      });
      expect(result.error, `${label} agent assignment: ${result.text}`).toBe("ASSIGNEE_NOT_IN_WORKSPACE");
    }
    // Skipping the scope confirmation for a granted agent with no prior task in the doc is refused.
    const skipped = await replay(author, captured!, {
      ...baseInput, body: `${token("agent", readAgentId, "x")} do`, task: { title: "no confirm", priority: "MEDIUM", dueDate: null }, agentScopeConfirmed: false,
    });
    expect(skipped.error).toBe("AGENT_SCOPE_CONFIRMATION_REQUIRED");
    // Assigning to an org member who is outside the workspace is refused.
    const outside = await replay(author, captured!, {
      ...baseInput, body: `${token("user", dUserId, "d")} do`, task: { title: "outsider task", priority: "MEDIUM", dueDate: null },
    });
    expect(outside.error).toBe("ASSIGNEE_NOT_IN_WORKSPACE");
    // Assigning to a user that exists nowhere near this org is refused.
    const stranger = await replay(author, captured!, {
      ...baseInput, body: `${token("user", xUserId, "x")} do`, task: { title: "stranger task", priority: "MEDIUM", dueDate: null },
    });
    expect(stranger.error).toBe("ASSIGNEE_NOT_IN_WORKSPACE");
    expect((await taskRows(docId)).length, "every refused request left no task behind").toBe(0);
    expect((await commentIdsOf(docId)).length, "every refused request left no comment behind (only the seed comment)").toBe(1);
    mark("refusals done");
    // Empty title / over-long title are handled.
    const emptyTitle = await replay(author, captured!, { ...baseInput, body: `${token("user", bUserId, "b")} do`, task: { title: "   ", priority: "MEDIUM", dueDate: null } });
    expect(emptyTitle.error).toBe("EMPTY_TITLE");
    const hugeTitle = await replay(author, captured!, { ...baseInput, body: `${token("user", bUserId, "b")} huge`, task: { title: "T".repeat(5000), priority: "MEDIUM", dueDate: "2026-02-31" } });
    finding("finding: 5000-char title + impossible date", `status=${hugeTitle.status} ok=${hugeTitle.ok} error=${hugeTitle.error} ${hugeTitle.text.slice(0, 120)}` );
    mark("huge title done");
    const badPriority = await replay(author, captured!, { ...baseInput, body: `${token("user", bUserId, "b")} pri`, task: { title: "bad priority", priority: "NOPE", dueDate: null } });
    const storedPriority = (await pool.query(`SELECT priority, due_date FROM "${S}".tasks WHERE title = 'bad priority' LIMIT 1`)).rows[0];
    finding("stored bad-priority task", JSON.stringify(storedPriority));
    const storedHuge = (await pool.query(`SELECT length(title) AS len, due_date FROM "${S}".tasks WHERE title LIKE 'TTTT%' LIMIT 1`)).rows[0];
    finding("stored 5000-char task", JSON.stringify(storedHuge));
    finding("finding: invalid priority", `status=${badPriority.status} ok=${badPriority.ok} error=${badPriority.error} ${badPriority.text.slice(0, 160)}` );
    mark("bad priority done");
    // Parent that is a reply / parent from another doc.
    const otherDoc = await seedDoc(`Other ${suffix}`, "OTHER");
    const rootId = (await commentIdsOf(docId))[0].id;
    const crossDoc = await replay(author, captured!, { docId: otherDoc, body: "cross-doc reply", parentId: rootId, task: null, assignee: null });
    finding("finding: reply to a parent comment from another doc", `ok=${crossDoc.ok} error=${crossDoc.error}` );
    expect(crossDoc.ok, "a reply must not attach to a parent that belongs to a different doc").toBe(false);

    // Outsider D (org member, no workspace membership) cannot comment or make tasks through the action.
    const dForged = await replay(dApi, captured!, { ...baseInput, body: `${token("user", bUserId, "b")} sneaky`, task: { title: "viewer task", priority: "MEDIUM", dueDate: null } });
    expect(dForged.error, `outsider create task: ${dForged.text}`).toBe("FORBIDDEN");
    const dPlain = await replay(dApi, captured!, { ...baseInput, body: "plain comment from outsider", task: null, assignee: null });
    expect(dPlain.error, `outsider plain comment: ${dPlain.text}`).toBe("FORBIDDEN");
    expect((await taskRows(docId)).filter((t) => t.title === "viewer task"), "outsider's forged task").toEqual([]);

    mark("outsider forged done");
    // What does D see in the UI?
    const dContext = await browser.newContext({ baseURL, storageState: await dApi.storageState() });
    contexts.push(dContext);
    const dPage = await dContext.newPage();
    watchConsole(dPage, "outsider-ui");
    const dResponse = await dPage.goto(`${base}/docs/${docId}`);
    await dPage.waitForLoadState("domcontentloaded");
    await dPage.waitForTimeout(1500);
    const dUrl = new URL(dPage.url()).pathname;
    const hasEditor = await dPage.locator(".ProseMirror").count();
    const commentButtonEnabled = hasEditor ? await dPage.getByTitle("Comment on selection").isEnabled().catch(() => false) : false;
    finding("finding: outsider (org member, no workspace) opening the doc", `status=${dResponse?.status()} landed=${dUrl} editor=${hasEditor} commentButtonEnabled=${commentButtonEnabled}` );
    await shot(dPage, "adv-outsider-doc");

    // Forged mention token for a user with no relation to the org: do they get notified / followed?
    const before = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM "${S}".notifications WHERE recipient_user_id = $1`, [xUserId])).rows[0].n);
    const forged = await replay(author, captured!, { ...baseInput, body: `hello ${token("user", xUserId, "Stranger")} look at this doc`, task: null, assignee: null });
    expect(forged.ok, forged.text).toBe(true);
    await page.waitForTimeout(1500);
    const after = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM "${S}".notifications WHERE recipient_user_id = $1`, [xUserId])).rows[0].n);
    const follows = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM "${S}".follows WHERE user_id = $1 AND subject_id = $2`, [xUserId, docId])).rows[0].n);
    const payload = (await pool.query(`SELECT * FROM "${S}".notifications WHERE recipient_user_id = $1 ORDER BY created_at DESC LIMIT 1`, [xUserId])).rows[0];
    finding("finding: forged mention of a user with no org/workspace relation", `notifications ${before}->${after}, follows on doc=${follows}, row=${payload ? JSON.stringify(payload).slice(0, 400) : "none"}`
    );
    expect(after - before, "a user outside the workspace must not receive a notification/follow for a doc they cannot open").toBe(0);
    expect(follows).toBe(0);
    expect(errors).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  test("390px phone: scope confirm, outside alert, task card sheet, 255-char title, very long name, no sideways scroll", async ({ page, base }) => {
    test.setTimeout(300_000);
    const errors = watchConsole(page, "phone");
    await page.setViewportSize({ width: 390, height: 844 });
    const longName = "Wolfeschlegelsteinhausenbergerdorff".repeat(2) + ` ${suffix}`;
    await pool.query(`UPDATE "${S}".users SET name = $1 WHERE id = $2`, [longName, wUserId]);
    const docId = await openDocWithSelection(page, base, `Phone ${suffix} with a rather long title that keeps going and going to stress the header`, "HOTEL");
    const inside = async (locator: ReturnType<Page["locator"]>, what: string) => {
      const box = await locator.boundingBox();
      expect(box, `${what} has a box`).not.toBeNull();
      if (box!.x + box!.width > 390.5 || box!.x < -0.5) finding("phone overflow", `${what}: x=${box!.x} right=${box!.x + box!.width}`);
      expect.soft(box!.x, `${what} left edge`).toBeGreaterThanOrEqual(-0.5);
      expect.soft(box!.x + box!.width, `${what} right edge`).toBeLessThanOrEqual(390.5);
    };
    const noSideScroll = async (what: string) =>
      expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), `${what}: page scrolls sideways`).toBeLessThanOrEqual(390);

    let editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("@");
    // How much of the picker can a phone user actually see without scrolling the popover?
    await expect(page.getByTestId("mention-picker")).toBeVisible();
    const visibility = await page.evaluate(() => {
      const pop = document.querySelector('[data-testid="new-comment-popover"]')!.getBoundingClientRect();
      const options = [...document.querySelectorAll('[data-testid="mention-option"]')].map((el) => el.getBoundingClientRect());
      const inView = options.filter((r) => r.top >= pop.top && r.bottom <= pop.bottom && r.bottom <= window.innerHeight).length;
      return { options: options.length, fullyVisibleInPopover: inView, popoverHeight: Math.round(pop.height), viewport: window.innerHeight };
    });
    finding("phone picker visibility (all options, '@' only)", JSON.stringify(visibility));
    await shot(page, "adv-phone-picker-all");
    expect.soft(visibility.fullyVisibleInPopover, `phone picker: only ${visibility.fullyVisibleInPopover} of ${visibility.options} options visible without scrolling the popover`).toBeGreaterThanOrEqual(Math.min(3, visibility.options));
    for (const ch of "Wolfe") await page.keyboard.type(ch);
    await inside(page.getByTestId("mention-picker"), "picker with a very long name");
    const optionBox = await page.getByTestId("mention-option").first().boundingBox();
    expect(optionBox!.x + optionBox!.width).toBeLessThanOrEqual(390.5);
    await shot(page, "adv-phone-picker-long-name");
    await page.keyboard.press("Enter");
    await inside(page.getByTestId("comment-task-box"), "task box with long name chip");
    await noSideScroll("composer with long-name chip");
    const longTitle = "L".repeat(300);
    await page.getByLabel("Task title").fill(longTitle);
    expect((await page.getByLabel("Task title").inputValue()).length, "title capped at 255").toBe(255);
    await shot(page, "adv-phone-task-box");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(page.getByTestId("doc-comment-thread").or(page.getByTestId("comment-task-card")).first()).toBeVisible({ timeout: 20_000 });
    await openCommentsPanel(page);
    const card = page.getByTestId("comment-task-card");
    await expect(card).toBeVisible();
    await page.waitForTimeout(800); // sheet slide-in
    const cardMetrics = await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const title = el.querySelector("p")!;
      (window as unknown as { __titleRight: number }).__titleRight = title.getBoundingClientRect().right;
      const list = el.closest('[data-testid="doc-comments-list"]')!.getBoundingClientRect();
      return { cardLeft: r.left, cardRight: r.right, listRight: list.right, titleScrollW: title.scrollWidth, titleClientW: title.clientWidth };
    });
    finding("phone card metrics", JSON.stringify(cardMetrics));
    expect.soft(cardMetrics.titleClientW, "task title wraps inside the card (255 chars, no spaces)").toBeLessThanOrEqual(cardMetrics.cardRight - cardMetrics.cardLeft);
    await inside(card, "task card with 255-char unbroken title + long assignee");
    await noSideScroll("sheet with long title card");
    await shot(page, "adv-phone-card-long");
    // Also the comment body: a very long mention chip is nowrap.
    const bodyMetrics = await page.getByTestId("doc-comments-list").getByTestId("comment-mention").first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      const list = el.closest('[data-testid="doc-comments-list"]')!.getBoundingClientRect();
      return { chipRight: r.right, listRight: list.right };
    });
    finding("phone long-name chip in comment body", JSON.stringify(bodyMetrics));
    expect.soft(bodyMetrics.chipRight, "long-name mention chip stays inside the comments list").toBeLessThanOrEqual(bodyMetrics.listRight + 0.5);
    expect((await taskRows(docId))[0].title.length).toBe(255);

    // Agent scope confirm on the phone.
    await closeCommentsPanel(page);
    await page.locator(".ProseMirror").click();
    await selectLeadingWord(page, "HOTEL");
    editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("run it @Adv Agent");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    const confirm = page.getByTestId("agent-scope-confirm");
    await expect(confirm).toBeVisible();
    await inside(confirm, "agent scope confirm");
    await inside(page.getByTestId("confirm-agent-assign"), "confirm button");
    await noSideScroll("scope confirm");
    await shot(page, "adv-phone-scope");
    // The confirm buttons are reachable (not clipped below the popover's scroll area).
    await page.getByTestId("confirm-agent-assign").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("confirm-agent-assign")).toBeInViewport();
    await page.getByTestId("confirm-agent-assign").click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(2, { timeout: 20_000 });

    // Outside-workspace alert on the phone.
    await closeCommentsPanel(page);
    await page.locator(".ProseMirror").click();
    await selectLeadingWord(page, "HOTEL");
    editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("@Dale");
    await page.keyboard.press("Enter");
    await inside(page.getByTestId("outside-workspace-alert"), "outside alert");
    await noSideScroll("outside alert");
    await shot(page, "adv-phone-outside");

    await pool.query(`UPDATE "${S}".users SET name = $1 WHERE id = $2`, [wName, wUserId]);
    expect(errors).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  test("long and hostile names and bodies: brackets, markdown, token look-alikes, RTL, emoji", async ({ page, base }) => {
    test.setTimeout(240_000);
    const errors = watchConsole(page, "hostile");
    await dockPanel(page);
    const hostileName = `Eve ]( mention:user:${randomUUID()}) [x] <img src=x onerror=alert(1)> ${suffix}`;
    await pool.query(`UPDATE "${S}".users SET name = $1 WHERE id = $2`, [hostileName, wUserId]);
    try {
      const docId = await openDocWithSelection(page, base, `Hostile ${suffix}`, "INDIA");
      const editor = await startComment(page);
      await editor.click();
      await page.keyboard.type("@Eve");
      await page.getByTestId("mention-option").first().waitFor();
      await page.keyboard.press("Enter");
      await page.keyboard.type("ok ");
      // Type a literal token look-alike for Rowan: the composer serializes plain text as-is.
      await page.keyboard.type(`and also the literal text @[Fake](mention:user:${bUserId}) here ‮rtl 😀 *bold* [link](http://x.y)`);
      await page.getByRole("button", { name: "Comment & create task" }).click();
      await expect(page.getByTestId("comment-task-card")).toBeVisible({ timeout: 20_000 });
      const [row] = await taskRows(docId);
      expect(row.assignee_user_id, "the hostile-named user is the assignee, not Rowan").toBe(wUserId);
      const chips = await page.getByTestId("doc-comments-list").getByTestId("comment-mention").evaluateAll((els) => els.map((el) => el.getAttribute("data-mention-id")));
      finding("finding: typed literal token becomes a real mention", `chips in thread: ${chips.length} (ids: ${chips.map((c) => (c === bUserId ? "ROWAN" : c === wUserId ? "EVE" : c)).join(",")})` );
      expect(await page.evaluate(() => (window as unknown as { __xss?: boolean }).__xss)).toBeUndefined();
      expect(await page.locator('img[src="x"]').count(), "name rendered as text, not HTML").toBe(0);
      await shot(page, "adv-hostile");
    } finally {
      await pool.query(`UPDATE "${S}".users SET name = $1 WHERE id = $2`, [wName, wUserId]);
    }
    expect(errors).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  test("isolate the React unique-key warning from DocEditor", async ({ page, base }) => {
    test.setTimeout(300_000);
    await page.addInitScript(() => {
      const w = window as unknown as { __keyWarn: Array<{ stack: string; text: string }> };
      w.__keyWarn = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        const text = args.map(String).join(" ");
        if (text.includes('unique "key" prop')) w.__keyWarn.push({ text: text.slice(0, 300), stack: (new Error().stack ?? "").split("\n").slice(1, 14).join("\n") });
        original.apply(console, args as []);
      };
    });
    const step = async (label: string) => {
      await page.waitForTimeout(1500);
      const found = await page.evaluate(() => (window as unknown as { __keyWarn: Array<{ stack: string; text: string }> }).__keyWarn.splice(0));
      finding(`key-warning after "${label}"`, `${found.length}${found[0] ? `\n${found[0].text}\n${found[0].stack}` : ""}`);
      return found.length;
    };
    await dockPanel(page);
    const docId = await openDocWithSelection(page, base, `Keys ${suffix}`, "JULIET");
    await step("load, no comments");

    // plain comment, no mention
    let editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("plain");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByTestId("doc-comment-thread")).toHaveCount(1, { timeout: 20_000 });
    await step("plain comment posted");
    await page.reload();
    await expect(page.locator(".ProseMirror")).toContainText("JULIET");
    await step("reload with a plain comment");

    // mention-only
    await openDocWithSelection(page, base, `Keys2 ${suffix}`, "KILO").then(() => undefined);
    await step("load second doc");
    editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("fyi @Rowan");
    await page.keyboard.press("Enter");
    await page.getByTestId("create-task-toggle").click();
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByTestId("doc-comment-thread")).toHaveCount(1, { timeout: 20_000 });
    await step("mention-only posted");

    // task for Rowan
    await closeCommentsPanel(page);
    await page.locator(".ProseMirror").click();
    await selectLeadingWord(page, "KILO");
    editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("do it @Rowan");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(1, { timeout: 20_000 });
    await step("task for Rowan posted");
    await page.reload();
    await expect(page.locator(".ProseMirror")).toContainText("KILO");
    await step("reload with a task");
    // Read the Next dev overlay's own diagnosis (it carries the component stack).
    const overlay = await page.evaluate(async () => {
      const root = document.querySelector("nextjs-portal")?.shadowRoot;
      if (!root) return "no overlay";
      const pill = [...root.querySelectorAll("button")].find((b) => /issue/i.test(b.textContent ?? ""));
      (pill as HTMLElement | undefined)?.click();
      await new Promise((r) => setTimeout(r, 1500));
      const parts = [...root.querySelectorAll("div, section, dialog")].filter((e) => (e as HTMLElement).innerText && !e.querySelector("div, section")).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim());
      return parts.join(" || ").slice(0, 3500);
    });
    finding("overlay text", overlay);
    expect(docId).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────────────
  for (const [label, size] of [["desktop 1280x720", { width: 1280, height: 720 }], ["phone 390x844", { width: 390, height: 844 }]] as const) {
    test(`reply composer picker is not clipped by the thread list (${label})`, async ({ page, base }) => {
      test.setTimeout(240_000);
      const errors = watchConsole(page, `reply-picker-${size.width}`);
      await page.setViewportSize(size);
      if (size.width > 600) await dockPanel(page);
      await openDocWithSelection(page, base, `ReplyPicker ${size.width} ${suffix}`, "LIMA");
      const editor = await startComment(page);
      await editor.click();
      await page.keyboard.type("a plain thread");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(page.getByTestId("doc-comment-thread").first()).toBeVisible({ timeout: 20_000 });
      await openCommentsPanel(page);
      const reply = page.getByRole("textbox", { name: "Reply", exact: true });
      await reply.scrollIntoViewIfNeeded();
      await reply.click();
      await page.keyboard.type("@");
      await expect(page.getByTestId("mention-picker")).toBeVisible();
      await page.waitForTimeout(500);
      const m = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="doc-comments-list"]')!.getBoundingClientRect();
        const picker = document.querySelector('[data-testid="mention-picker"]')!.getBoundingClientRect();
        const opts = [...document.querySelectorAll('[data-testid="mention-option"]')].map((el) => el.getBoundingClientRect());
        const visible = opts.filter((r) => r.top >= Math.max(list.top, 0) && r.bottom <= Math.min(list.bottom, window.innerHeight)).length;
        return { listTop: Math.round(list.top), listBottom: Math.round(list.bottom), pickerTop: Math.round(picker.top), pickerBottom: Math.round(picker.bottom), options: opts.length, fullyVisible: visible };
      });
      finding(`reply picker ${label}`, JSON.stringify(m));
      await shot(page, `adv-reply-picker-${size.width}`);
      expect.soft(m.fullyVisible, `reply picker (${label}): ${m.fullyVisible}/${m.options} options fully visible`).toBeGreaterThanOrEqual(Math.min(3, m.options));
      expect(errors).toEqual([]);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  test("race: concurrent task status flips leave thread and task in agreement", async ({ page, base }) => {
    test.setTimeout(300_000);
    watchConsole(page, "race");
    await dockPanel(page);
    const docId = await openDocWithSelection(page, base, `Race ${suffix}`, "MIKE");
    const editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("race me @Rowan");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(1, { timeout: 20_000 });
    const [task] = await taskRows(docId);
    const rootId = (await commentIdsOf(docId))[0].id;
    const orders = [["DONE", "TODO"], ["TODO", "DONE"], ["DONE", "TODO", "DONE"], ["DONE", "IN_PROGRESS", "DONE", "TODO"], ["IN_PROGRESS", "DONE"], ["DONE", "DONE", "TODO"]];
    let disagreements = 0;
    const detail: string[] = [];
    for (let i = 0; i < 18; i++) {
      const order = orders[i % orders.length];
      await Promise.all(order.map((status) => page.request.patch(`/api/panels/entity/task/${task.id}?${query}`, { data: { field: "status", value: status } })));
      await page.waitForTimeout(700);
      const status = (await pool.query(`SELECT status FROM "${S}".tasks WHERE id = $1`, [task.id])).rows[0].status as string;
      const thread = await threadStatus(rootId);
      const expected = status === "DONE" ? "RESOLVED" : "OPEN";
      // CANCELLED aside, a thread whose only task is live must be open and one whose only task is Done must be resolved.
      if (thread !== expected) { disagreements += 1; detail.push(`[${order.join(">")}] task=${status} thread=${thread}`); }
    }
    finding("race: concurrent status flips", `${disagreements}/18 rounds ended with thread and task disagreeing. ${detail.join("; ")}`);
    expect.soft(disagreements, `thread/task disagree after concurrent flips: ${detail.join("; ")}`).toBe(0);
  });
});
