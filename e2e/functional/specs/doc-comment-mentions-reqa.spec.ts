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

test.describe("Re-QA a022c39e", () => {
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
      // Notifications these flows generated (for the shared dev user too) would break the next spec's unread counts.
      await pool.query(`DELETE FROM "${S}".notifications WHERE recipient_user_id = ANY($1::uuid[])`, [[aUserId, bUserId, wUserId, dUserId, xUserId].filter(Boolean)]).catch(() => undefined);
      // The bulk members seeded for the long-picker tests.
      await pool.query(`DELETE FROM "${S}".workspace_members WHERE user_id IN (SELECT id FROM "${S}".users WHERE email LIKE 'bulk-%-${suffix}-%@localhost.dev')`).catch(() => undefined);
      await pool.query(`DELETE FROM "${S}".users WHERE email LIKE 'bulk-%-${suffix}-%@localhost.dev'`).catch(() => undefined);
      // Leave no "Rowan"/"Wren"-style members behind: the next spec's "@Rowan" must resolve to its own user.
      for (const userId of [bUserId, wUserId, dUserId, xUserId].filter(Boolean)) {
        await pool.query(`DELETE FROM "${S}".workspace_members WHERE user_id = $1`, [userId]).catch(() => undefined);
        await pool.query(`DELETE FROM "${S}".organization_members WHERE user_id = $1`, [userId]).catch(() => undefined);
      }
      await pool.end();
    }
    for (const context of contexts) await context.close();
    for (const api of apis) await api.dispose();
    fs.mkdirSync("test-results", { recursive: true });
    fs.appendFileSync("test-results/adversarial-console.log", allConsole.join("\n---\n") + "\n---\n");
  });


  // ── helpers specific to the re-QA ────────────────────────────────────────
  const PICKER_SIZES = [
    { name: "phone 390x844", width: 390, height: 844 },
    { name: "short phone 390x667", width: 390, height: 667 },
    { name: "desktop 1280x720", width: 1280, height: 720 },
  ] as const;

  async function seedBulkMembers(n: number) {
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      const email = `bulk-${i}-${suffix}-${randomUUID().slice(0, 6)}@localhost.dev`; // unique per call: the helper runs once per viewport
      await pool.query(`INSERT INTO "${S}".users (id, email, name) VALUES ($1, $2, $3)`, [id, email, `Bulk Person ${String(i).padStart(2, "0")} ${suffix}`]);
      await pool.query(`INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW())`, [workspaceId, id]);
    }
  }

  /** Geometry of the open picker: where it is, what is visible, what covers the active row. */
  async function pickerGeometry(page: Page) {
    return page.evaluate(() => {
      const picker = document.querySelector('[data-testid="mention-picker"]') as HTMLElement | null;
      if (!picker) return null;
      const listbox = picker.querySelector('[role="listbox"]') as HTMLElement;
      const lr = listbox.getBoundingClientRect();
      const pr = picker.getBoundingClientRect();
      const active = listbox.querySelector('[aria-selected="true"]') as HTMLElement | null;
      const ar = active?.getBoundingClientRect();
      const vh = window.innerHeight;
      const editor = document.activeElement as HTMLElement;
      const er = editor?.getBoundingClientRect();
      const options = [...listbox.querySelectorAll('[role="option"]')] as HTMLElement[];
      const visibleOptions = options.filter((o) => { const r = o.getBoundingClientRect(); return r.top >= lr.top - 0.5 && r.bottom <= lr.bottom + 0.5 && r.top >= 0 && r.bottom <= vh; }).length;
      let covered = false;
      if (ar) {
        const el = document.elementFromPoint(ar.left + ar.width / 2, ar.top + ar.height / 2);
        covered = !(el && active!.contains(el));
      }
      return {
        pickerTop: Math.round(pr.top), pickerBottom: Math.round(pr.bottom), pickerLeft: Math.round(pr.left), pickerRight: Math.round(pr.right), vh,
        listScrollable: listbox.scrollHeight > listbox.clientHeight + 1,
        options: options.length, visibleOptions,
        activeVisible: !!ar && ar.top >= lr.top - 0.5 && ar.bottom <= lr.bottom + 0.5 && ar.top >= 0 && ar.bottom <= vh,
        activeCovered: covered,
        editorVisible: !!er && er.top >= 0 && er.bottom <= vh,
        scrollY: Math.round(window.scrollY),
      };
    });
  }

  async function exercisePicker(page: Page, label: string, editorLocator: ReturnType<Page["getByRole"]>) {
    await editorLocator.click();
    await page.keyboard.type("@");
    await expect(page.getByTestId("mention-picker")).toBeVisible();
    await page.waitForTimeout(400);
    const first = (await pickerGeometry(page))!;
    finding(`picker ${label} open`, JSON.stringify(first));
    expect.soft(first.pickerTop, `${label}: picker top inside viewport`).toBeGreaterThanOrEqual(0);
    expect.soft(first.pickerBottom, `${label}: picker bottom inside viewport`).toBeLessThanOrEqual(first.vh + 0.5);
    expect.soft(first.pickerRight, `${label}: picker right edge inside viewport`).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
    expect.soft(first.visibleOptions, `${label}: at least 3 options visible without touching anything`).toBeGreaterThanOrEqual(Math.min(3, first.options));
    expect.soft(first.activeVisible, `${label}: active row visible on open`).toBe(true);
    expect.soft(first.activeCovered, `${label}: active row not covered by another layer`).toBe(false);
    // Walk the whole list downward by keyboard; the active row must stay visible and uncovered each step.
    const total = first.options;
    const bad: string[] = [];
    for (let i = 1; i <= total + 1; i++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(60);
      const g = (await pickerGeometry(page))!;
      if (!g.activeVisible || g.activeCovered || !g.editorVisible) bad.push(`down#${i}: activeVisible=${g.activeVisible} covered=${g.activeCovered} editorVisible=${g.editorVisible} scrollY=${g.scrollY}`);
    }
    for (let i = 1; i <= 3; i++) {
      await page.keyboard.press("ArrowUp");
      await page.waitForTimeout(60);
      const g = (await pickerGeometry(page))!;
      if (!g.activeVisible || g.activeCovered) bad.push(`up#${i}: activeVisible=${g.activeVisible} covered=${g.activeCovered}`);
    }
    finding(`picker ${label} keyboard walk`, bad.length ? bad.join(" | ") : `ok over ${total} options (list scrollable=${first.listScrollable})`);
    expect.soft(bad, `${label}: keyboard walk kept the active row visible`).toEqual([]);
    // Wrap to the very last row and select it with Enter: it must become a chip.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("mention-chip")).toHaveCount(1);
    await expect(page.getByTestId("mention-picker")).toBeHidden();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // (1) Picker usability in the new-comment popover and the reply composer
  for (const size of PICKER_SIZES) {
    test(`1a picker in the new-comment popover: ${size.name}`, async ({ page, base }) => {
      test.setTimeout(240_000);
      const errors = watchConsole(page, `1a-${size.width}x${size.height}`);
      await page.setViewportSize({ width: size.width, height: size.height });
      if (size.width > 600) await dockPanel(page);
      await openDocWithSelection(page, base, `Pop ${size.width}x${size.height} ${suffix}`, "NOVEMBER");
      const editor = await startComment(page);
      await exercisePicker(page, `popover ${size.name}`, editor);
      // After selecting: the submit button must be reachable on screen.
      const button = page.getByRole("button", { name: "Comment & create task" });
      await button.scrollIntoViewIfNeeded();
      await expect.soft(button, `popover ${size.name}: submit reachable`).toBeInViewport();
      const popBox = await page.getByTestId("new-comment-popover").boundingBox();
      finding(`popover ${size.name} after pick`, JSON.stringify(popBox));
      await shot(page, `reqa-1a-${size.width}x${size.height}`);
      expect(errors).toEqual([]);
    });

    test(`1b picker in the reply composer: ${size.name}`, async ({ page, base }) => {
      test.setTimeout(240_000);
      const errors = watchConsole(page, `1b-${size.width}x${size.height}`);
      await page.setViewportSize({ width: size.width, height: size.height });
      if (size.width > 600) await dockPanel(page);
      await openDocWithSelection(page, base, `Rep ${size.width}x${size.height} ${suffix}`, "OSCAR");
      const first = await startComment(page);
      await first.click();
      await page.keyboard.type("short thread");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(page.getByTestId("doc-comment-thread").first()).toBeVisible({ timeout: 20_000 });
      await openCommentsPanel(page);
      const reply = page.getByRole("textbox", { name: "Reply", exact: true });
      await reply.scrollIntoViewIfNeeded();
      const threadBefore = await page.getByTestId("doc-comment-thread").first().boundingBox();
      await exercisePicker(page, `reply ${size.name}`, reply);
      const threadAfter = await page.getByTestId("doc-comment-thread").first().boundingBox();
      finding(`reply ${size.name} thread height`, `${Math.round(threadBefore!.height)} -> ${Math.round(threadAfter!.height)} (with chip + task box)`);
      // The thread's own actions and the submit stay reachable while the composer is expanded.
      await page.getByRole("button", { name: "Comment & create task" }).scrollIntoViewIfNeeded();
      await expect.soft(page.getByRole("button", { name: "Comment & create task" }), `reply ${size.name}: submit reachable`).toBeInViewport();
      await shot(page, `reqa-1b-${size.width}x${size.height}`);
      // Re-open the picker, dismiss with Esc: the layout returns to its pre-picker height (no leftover gap).
      await reply.click();
      await page.keyboard.press("End");
      await page.keyboard.type(" @");
      await expect(page.getByTestId("mention-picker")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("mention-picker")).toBeHidden();
      const threadClosed = await page.getByTestId("doc-comment-thread").first().boundingBox();
      expect.soft(Math.abs(threadClosed!.height - threadAfter!.height), `reply ${size.name}: thread height returns after Esc`).toBeLessThanOrEqual(24);
      expect(errors).toEqual([]);
    });
  }

  test("1c picker with many people (cap 8) scrolls inside, with keyboard, on phone, in a docked desktop panel", async ({ page, base }) => {
    test.setTimeout(240_000);
    await seedBulkMembers(10);
    watchConsole(page, "1c");
    for (const size of [PICKER_SIZES[0], PICKER_SIZES[2]]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      if (size.width > 600) await dockPanel(page);
      await openDocWithSelection(page, base, `Many ${size.width} ${suffix}`, "PAPA");
      const editor = await startComment(page);
      await exercisePicker(page, `many ${size.name}`, editor);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (2) scope confirm no longer sticks
  test("2 scope confirm: Backspace the chip, edit the body, swap assignee, Cancel, and still assign", async ({ page, base }) => {
    test.setTimeout(240_000);
    const errors = watchConsole(page, "2");
    await dockPanel(page);
    const docId = await openDocWithSelection(page, base, `ScopeFix ${suffix}`, "QUEBEC");
    const editor = await startComment(page);
    const confirm = page.getByTestId("agent-scope-confirm");
    const submit = page.getByRole("button", { name: /^Comment/ });
    async function openConfirm(agent: string) {
      await editor.click();
      await page.keyboard.type(`do it @${agent}`);
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Comment & create task" }).click();
      await expect(confirm).toBeVisible();
    }
    // (a) Backspace the chip behind the confirm.
    await openConfirm("Adv Agent");
    await editor.click(); await page.keyboard.press("End");
    await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace");
    await expect(page.getByTestId("mention-chip")).toHaveCount(0);
    await expect(confirm).toBeHidden();
    await expect(submit.first()).toBeVisible();
    await expect(submit.first()).toBeEnabled();
    // (b) Re-mention, open the confirm, then just type more text: the confirm must go away (body changed after the preview).
    await page.keyboard.type("@Adv Agent"); await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(confirm).toBeVisible();
    await editor.click(); await page.keyboard.press("End");
    await page.keyboard.type(" extra words");
    await expect.soft(confirm, "typing while the confirm is up dismisses it").toBeHidden();
    await expect(page.getByRole("button", { name: "Comment & create task" })).toBeVisible();
    // (c) Swap the assignee behind an open confirm: read-only agent instead of the write agent. The confirm must reflect the new one, not the old.
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(confirm).toBeVisible();
    await editor.click(); await page.keyboard.press("End");
    for (let i = 0; i < 12; i++) await page.keyboard.press("Backspace"); // " extra words" removed
    await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace");
    await expect(page.getByTestId("mention-chip")).toHaveCount(0);
    await page.keyboard.type("@Adv ReadOnly"); await page.keyboard.press("Enter");
    await expect(confirm).toBeHidden();
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(confirm).toContainText(readAgentName);
    await expect(confirm).toContainText("read-only");
    // (d) Cancel keeps the text and returns the buttons.
    await page.getByTestId("composer-actions").getByRole("button", { name: "Cancel" }).click(); // pinned action row, outside the scroll region
    await expect(confirm).toBeHidden();
    await expect(page.getByRole("button", { name: "Comment & create task" })).toBeVisible();
    expect((await taskRows(docId)).length, "nothing posted while cancelling").toBe(0);
    // (e) Assign for real after all of that: exactly one task, to the read-only agent.
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await page.getByTestId("confirm-agent-assign").click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(1, { timeout: 20_000 });
    const rows = await taskRows(docId);
    expect(rows).toHaveLength(1);
    expect(rows[0].assignee_agent_id).toBe(readAgentId);
    // (f) Esc inside the editor while the confirm is up cancels the composer, not stuck.
    await closeCommentsPanel(page);
    await page.locator(".ProseMirror").click();
    await selectLeadingWord(page, "QUEBEC");
    const editor2 = await startComment(page);
    await editor2.click(); await page.keyboard.type("again @Adv Agent"); await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(confirm).toBeVisible();
    await editor2.click(); await page.keyboard.press("Escape");
    await expect(page.getByTestId("new-comment-popover")).toBeHidden();
    expect(errors).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (3) Long unbroken title / long-name chip on a 390px phone
  test("3 long unbroken title and long-name chip at 390px (card, body, composer, roles, picker)", async ({ page, base }) => {
    test.setTimeout(240_000);
    const errors = watchConsole(page, "3");
    await page.setViewportSize({ width: 390, height: 844 });
    const longName = "Wolfeschlegelsteinhausenbergerdorff".repeat(2) + ` ${suffix}`;
    const longAgent = "A".repeat(90);
    await pool.query(`UPDATE "${S}".users SET name = $1 WHERE id = $2`, [longName, wUserId]);
    await pool.query(`UPDATE "${S}".agents SET name = $1 WHERE id = $2`, [longAgent, agentId]);
    try {
      const docId = await openDocWithSelection(page, base, `Long ${suffix} a rather long document title that keeps going and going`, "ROMEO");
      const editor = await startComment(page);
      await editor.click();
      await page.keyboard.type("@Wolfe"); await page.keyboard.press("Enter");
      await page.keyboard.type("@AAAA"); await page.keyboard.press("Enter");
      const rightEdges = async (selector: string) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => Math.round(el.getBoundingClientRect().right)), selector);
      const maxRight = async (sel: string) => Math.max(0, ...(await rightEdges(sel)));
      const offenders = await page.evaluate(() => [...document.querySelectorAll('[data-testid="comment-task-box"] *')].filter((el) => el.getBoundingClientRect().right > 390.5).map((el) => `${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").slice(0, 40)} right=${Math.round(el.getBoundingClientRect().right)} text="${(el.textContent ?? "").slice(0, 30)}"`));
      finding("3 composer offenders past 390", offenders.join(" | ") || "none");
      expect.soft(await maxRight('[data-testid="comment-task-box"] *'), "composer: nothing in the task box past 390").toBeLessThanOrEqual(390);
      expect.soft(await maxRight('[data-testid="doc-comment-editor"] .mention-chip'), "composer: chips inside the editor").toBeLessThanOrEqual(390);
      await page.getByLabel("Task title").fill("L".repeat(300));
      expect((await page.getByLabel("Task title").inputValue()).length).toBe(255);
      const submitBtn = page.getByRole("button", { name: "Comment & create task" });
      const coverInfo = await submitBtn.evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, window.innerHeight - 1)); return `btn top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} vh=${window.innerHeight} coveredBy=${top && !el.contains(top) ? (top.closest("a")?.getAttribute("href") ?? top.tagName) : "nothing"}`; });
      finding("3 submit reachability (two long-name mentions)", coverInfo);
      await submitBtn.dispatchEvent("click"); // bypass hit-testing: the nav may cover it, which is recorded above
      await expect(page.getByTestId("doc-comment-thread").first()).toBeVisible({ timeout: 20_000 });
      await openCommentsPanel(page);
      await page.waitForTimeout(800);
      const list = '[data-testid="doc-comments-list"]';
      const listRight = await page.evaluate((s) => Math.round(document.querySelector(s)!.getBoundingClientRect().right), list);
      const card = await page.getByTestId("comment-task-card").first().evaluate((el) => {
        const r = el.getBoundingClientRect(); const t = el.querySelector("p")!; const tr = t.getBoundingClientRect();
        const all = [...el.querySelectorAll("*")].map((e) => e.getBoundingClientRect().right);
        return { cardRight: Math.round(r.right), titleRight: Math.round(tr.right), titleH: Math.round(tr.height), widest: Math.round(Math.max(...all)) };
      });
      finding("3 card", JSON.stringify({ ...card, listRight }));
      expect.soft(card.titleRight, "card title inside the card").toBeLessThanOrEqual(card.cardRight + 0.5);
      expect.soft(card.widest, "everything in the card inside the card").toBeLessThanOrEqual(card.cardRight + 0.5);
      expect.soft(card.cardRight, "card inside the list").toBeLessThanOrEqual(listRight + 0.5);
      expect.soft(await maxRight(`${list} .mention-chip`), "posted long-name chips inside the list").toBeLessThanOrEqual(listRight + 0.5);
      expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), "no sideways page scroll").toBeLessThanOrEqual(390);
      await shot(page, "reqa-3-card");
      // The chip is still a single selectable unit with the id intact, and wrapped, not truncated.
      const chip = page.getByTestId("doc-comments-list").getByTestId("comment-mention").first();
      await expect(chip).toContainText("Wolfeschlegel");
      expect(errors).toEqual([]);
      expect((await taskRows(docId))[0].title.length).toBe(255);
    } finally {
      await pool.query(`UPDATE "${S}".users SET name = $1 WHERE id = $2`, [wName, wUserId]);
      await pool.query(`UPDATE "${S}".agents SET name = $1 WHERE id = $2`, [agentName, agentId]);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (4) DONE/TODO race: API, two users, and the real UI
  test("4a race via API: 24 rounds, mixed orders, two users, expect 0 disagreements", async ({ page, base }) => {
    test.setTimeout(400_000);
    watchConsole(page, "4a");
    await dockPanel(page);
    const docId = await openDocWithSelection(page, base, `Race2 ${suffix}`, "SIERRA");
    const editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("race me @Rowan"); await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(1, { timeout: 20_000 });
    const [task] = await taskRows(docId);
    const rootId = (await commentIdsOf(docId))[0].id;
    // Second user in the same workspace so requests come from two sessions.
    const patch = (client: APIRequestContext, status: string) => client.patch(`/api/panels/entity/task/${task.id}?${query}`, { data: { field: "status", value: status } });
    const orders: string[][] = [["DONE", "TODO"], ["TODO", "DONE"], ["DONE", "TODO", "DONE"], ["DONE", "IN_PROGRESS", "DONE", "TODO"], ["IN_PROGRESS", "DONE"], ["DONE", "DONE", "TODO"], ["DONE", "BLOCKED", "DONE", "IN_REVIEW", "DONE"], ["DONE", "TODO", "DONE", "TODO", "DONE", "TODO"]];
    let disagreements = 0; const detail: string[] = [];
    for (let i = 0; i < 24; i++) {
      const order = orders[i % orders.length];
      const clients = [page.request, bApi, wApi];
      await Promise.all(order.map((status, k) => patch(clients[k % 3], status)));
      await page.waitForTimeout(500);
      const status = (await pool.query(`SELECT status FROM "${S}".tasks WHERE id = $1`, [task.id])).rows[0].status as string;
      const thread = await threadStatus(rootId);
      const expected = status === "DONE" ? "RESOLVED" : "OPEN";
      if (thread !== expected) { disagreements += 1; detail.push(`#${i} [${order.join(">")}] task=${status} thread=${thread}`); }
    }
    finding("4a race API", `${disagreements}/24 disagreements ${detail.join("; ")}`);
    expect(disagreements, detail.join("; ")).toBe(0);
    // CANCELLED path: DONE -> CANCELLED leaves the thread resolved, CANCELLED -> TODO does not reopen it (not from DONE).
    await patch(page.request, "DONE"); await page.waitForTimeout(400);
    await patch(page.request, "CANCELLED"); await page.waitForTimeout(400);
    expect(await threadStatus(rootId), "DONE->CANCELLED leaves it resolved").toBe("RESOLVED");
  });

  test("4b race via the real UI: two signed-in users click status changes on the task page at the same time", async ({ page, base, browser }) => {
    test.setTimeout(400_000);
    watchConsole(page, "4b");
    await dockPanel(page);
    const docId = await openDocWithSelection(page, base, `Race3 ${suffix}`, "TANGO");
    const editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("ui race @Rowan"); await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(1, { timeout: 20_000 });
    const [task] = await taskRows(docId);
    const rootId = (await commentIdsOf(docId))[0].id;
    const bContext = await browser.newContext({ baseURL, storageState: await bApi.storageState() });
    contexts.push(bContext);
    const bPage = await bContext.newPage();
    watchConsole(bPage, "4b-user-b");
    const taskUrl = `${base}/tasks/${task.id}`;
    await Promise.all([page.goto(taskUrl), bPage.goto(taskUrl)]);
    const trigger = (p: Page) => p.getByRole("combobox", { name: "Status" });
    await expect(trigger(page)).toBeVisible({ timeout: 60_000 });
    await expect(trigger(bPage)).toBeVisible({ timeout: 60_000 });
    const choose = async (p: Page, label: RegExp) => {
      await trigger(p).click();
      await p.getByRole("option", { name: label }).click();
    };
    let disagreements = 0; const detail: string[] = [];
    const rounds: Array<[RegExp, RegExp]> = [[/^Done$/, /^To Do$/], [/^To Do$/, /^Done$/], [/^Done$/, /^In Progress$/], [/^In Progress$/, /^Done$/], [/^Done$/, /^To Do$/], [/^To Do$/, /^Done$/], [/^Done$/, /^Blocked$/], [/^Done$/, /^To Do$/], [/^Done$/, /^In Progress$/], [/^To Do$/, /^Done$/]];
    for (let i = 0; i < rounds.length; i++) {
      const [a, b] = rounds[i];
      await Promise.all([choose(page, a).catch(() => undefined), choose(bPage, b).catch(() => undefined)]);
      await page.waitForTimeout(1200);
      const status = (await pool.query(`SELECT status FROM "${S}".tasks WHERE id = $1`, [task.id])).rows[0].status as string;
      const thread = await threadStatus(rootId);
      const expected = status === "DONE" ? "RESOLVED" : "OPEN";
      if (thread !== expected) { disagreements += 1; detail.push(`#${i} ${a}/${b} task=${status} thread=${thread}`); }
      // Re-sync both pages so each shows the stored state before the next round.
      await Promise.all([page.reload(), bPage.reload()]);
      await Promise.all([expect(trigger(page)).toBeVisible({ timeout: 60_000 }), expect(trigger(bPage)).toBeVisible({ timeout: 60_000 })]);
    }
    finding("4b race UI", `${disagreements}/${rounds.length} disagreements ${detail.join("; ")}`);
    expect(disagreements, detail.join("; ")).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (5) forged invalid priority / date
  test("5 forged priority and due date are rejected and leave nothing behind; valid values still work", async ({ page, base, playwright }) => {
    test.setTimeout(240_000);
    watchConsole(page, "5");
    await dockPanel(page);
    const docId = await openDocWithSelection(page, base, `Forge ${suffix}`, "UNIFORM");
    const cap = captureAction(page);
    const editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("seed @Rowan"); await page.keyboard.press("Enter");
    await page.getByTestId("create-task-toggle").click();
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByTestId("doc-comment-thread")).toHaveCount(1, { timeout: 20_000 });
    const captured = cap.get()!;
    expect(captured).not.toBeNull();
    const author = await playwright.request.newContext({ baseURL, storageState: await page.context().storageState() });
    apis.push(author);
    const input = { docId, anchorText: "UNIFORM", anchorStart: 1, anchorEnd: 8, anchorPrefix: "", anchorSuffix: " the rollout" };
    const comments0 = (await commentIdsOf(docId)).length;
    const bad: Array<[string, unknown, string | null, string]> = [
      ["priority NOPE", "NOPE", null, "INVALID_PRIORITY"],
      ["priority lowercase", "high", null, "INVALID_PRIORITY"],
      ["priority empty", "", null, "INVALID_PRIORITY"],
      ["priority number", 5, null, "INVALID_PRIORITY"],
      ["priority null", null, null, "INVALID_PRIORITY"],
      ["priority object", { a: 1 }, null, "INVALID_PRIORITY"],
      ["priority proto", "__proto__", null, "INVALID_PRIORITY"],
      ["date Feb 31", "MEDIUM", "2026-02-31", "INVALID_DUE_DATE"],
      ["date Feb 29 non-leap", "MEDIUM", "2027-02-29", "INVALID_DUE_DATE"],
      ["date month 13", "MEDIUM", "2026-13-01", "INVALID_DUE_DATE"],
      ["date day 00", "MEDIUM", "2026-01-00", "INVALID_DUE_DATE"],
      ["date unpadded", "MEDIUM", "2026-1-1", "INVALID_DUE_DATE"],
      ["date text", "MEDIUM", "tomorrow", "INVALID_DUE_DATE"],
      ["date with time", "MEDIUM", "2026-05-05T00:00:00Z", "INVALID_DUE_DATE"],
      ["date 5-digit year", "MEDIUM", "12026-05-05", "INVALID_DUE_DATE"],
    ];
    const outcomes: string[] = [];
    for (const [label, priority, dueDate, expectedError] of bad) {
      const r = await replay(author, captured, { ...input, body: `${token("user", bUserId, "b")} forged ${label}`, task: { title: `forged ${label}`, priority, dueDate } });
      outcomes.push(`${label}: ${r.error ?? (r.ok ? "ACCEPTED" : `status ${r.status}`)}`);
      expect.soft(r.error, `${label}: ${r.text}`).toBe(expectedError);
    }
    finding("5 forged outcomes", outcomes.join(" | "));
    expect((await commentIdsOf(docId)).length, "no comment left behind by a rejected forged request").toBe(comments0);
    expect((await taskRows(docId)).length, "no task left behind").toBe(0);
    // Valid inputs still go through: leap day, default priority (omitted), all four priorities.
    const good: Array<[string, Record<string, unknown>]> = [
      ["leap day", { title: "ok leap", priority: "LOW", dueDate: "2028-02-29" }],
      ["omitted priority", { title: "ok default", dueDate: null }],
      ["URGENT", { title: "ok urgent", priority: "URGENT", dueDate: "2026-12-31" }],
    ];
    for (const [label, task] of good) {
      const r = await replay(author, captured, { ...input, body: `${token("user", bUserId, "b")} ok ${label}`, task });
      expect.soft(r.ok, `${label}: ${r.text}`).toBe(true);
    }
    const rows = (await pool.query(`SELECT t.title, t.priority, to_char(t.due_date,'YYYY-MM-DD') AS due FROM "${S}".tasks t JOIN "${S}".task_links l ON l.task_id = t.id WHERE l.linked_type='DOC' AND l.linked_id=$1 ORDER BY t.title`, [docId])).rows;
    finding("5 stored valid", JSON.stringify(rows));
    expect(rows.find((r) => r.title === "ok leap")?.due).toBe("2028-02-29");
    expect(rows.find((r) => r.title === "ok default")?.priority).toBe("MEDIUM");
    expect(rows.find((r) => r.title === "ok urgent")?.priority).toBe("URGENT");
    // The UI date field with a real date still posts.
    await closeCommentsPanel(page);
    await page.locator(".ProseMirror").click();
    await selectLeadingWord(page, "UNIFORM");
    const e2 = await startComment(page);
    await e2.click(); await page.keyboard.type("ui path @Wren"); await page.keyboard.press("Enter");
    await page.getByLabel("Due date").fill("2026-10-23");
    await page.getByLabel("Priority").selectOption("URGENT");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(page.getByTestId("comment-task-card").filter({ hasText: "Oct 23" })).toBeVisible({ timeout: 20_000 });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (6) React unique-key warning: repeated reload / post in dev
  test("6 React unique-key warning: repeated reloads and posts with a task thread present", async ({ browser, page, base }) => {
    test.setTimeout(400_000);
    const keyHits: string[] = [];
    const record = (label: string) => (m: import("@playwright/test").ConsoleMessage) => { if (m.type() === "error" && m.text().includes('unique "key"')) keyHits.push(`${label}: ${m.text().slice(0, 140)}`); };
    await dockPanel(page);
    page.on("console", record("main"));
    const docId = await openDocWithSelection(page, base, `Keys2 ${suffix}`, "VICTOR");
    let editor = await startComment(page);
    await editor.click();
    await page.keyboard.type("keys @Rowan"); await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(1, { timeout: 20_000 });
    await page.waitForTimeout(1500);
    for (let i = 0; i < 6; i++) {
      await page.reload();
      await expect(page.locator(".ProseMirror")).toContainText("VICTOR");
      await page.waitForTimeout(1200);
    }
    // Fresh contexts (React dedupes per page load): docked and not docked, 6 loads each, with the task thread present.
    for (const docked of [true, false]) {
      for (let i = 0; i < 6; i++) {
        const ctx = await browser.newContext({ baseURL, storageState: "e2e/functional/.auth/user.json" });
        if (docked) await ctx.addCookies([{ name: "compass_panel_docsComments", value: "1:440", url: baseURL }]);
        const p = await ctx.newPage();
        p.on("console", record(`fresh docked=${docked} #${i}`));
        await p.goto(`${base}/docs/${docId}`);
        await expect(p.locator(".ProseMirror")).toContainText("VICTOR", { timeout: 60_000 });
        await p.waitForTimeout(1500);
        await ctx.close();
      }
    }
    // More posts in-page: a second task for a watcher, a reply task, a plain comment.
    await closeCommentsPanel(page);
    await page.locator(".ProseMirror").click();
    await selectLeadingWord(page, "VICTOR");
    editor = await startComment(page);
    await editor.click(); await page.keyboard.type("second @Wren"); await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(2, { timeout: 20_000 });
    const reply = page.getByRole("textbox", { name: "Reply", exact: true }).first();
    await reply.click(); await page.keyboard.type("reply task @Rowan"); await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).first().click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(3, { timeout: 20_000 });
    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForTimeout(1500);
    finding("6 key warning hits", `${keyHits.length} ${keyHits.slice(0, 3).join(" | ")}`);
    expect(keyHits, "React unique-key warning appeared").toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (7) new-code regressions: paste via Range API, scrollIntoView side effects, unavailable cue
  test("7a paste: replaces selection, mid-text, with chip neighbours, '@' and newlines, markup stays text, undo behaviour", async ({ page, base }) => {
    test.setTimeout(240_000);
    const errors = watchConsole(page, "7a");
    await dockPanel(page);
    await openDocWithSelection(page, base, `Paste ${suffix}`, "WHISKEY");
    const editor = await startComment(page);
    await editor.click();
    const paste = (text: string) => page.evaluate((t) => {
      const el = document.querySelector('[data-testid="doc-comment-editor"]') as HTMLElement;
      const data = new DataTransfer(); data.setData("text/plain", t); data.setData("text/html", `<b>${t}</b>`);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
    const text = () => editor.evaluate((el) => el.textContent ?? "");
    await page.keyboard.type("start end");
    // mid-text: caret between "start " and "end"
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
    await paste("MID ");
    expect(await text()).toBe("start MID end");
    // replace a selection: select "MID " with shift+arrows
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
    await paste("REPL ");
    expect(await text()).toBe("start REPL end");
    // '@' in pasted text does not open the picker; newlines survive into the stored body
    await paste("x @Rowan y\nsecond line");
    await expect(page.getByTestId("mention-picker")).toBeHidden();
    // caret ends after the pasted text: typing continues there
    await page.keyboard.type("!");
    expect(await text()).toContain("second line!");
    expect(await editor.evaluate((el) => el.querySelectorAll("b, i, script, img, a").length), "no markup from clipboard").toBe(0);
    // next to a chip: pick a chip, paste right after it
    await page.keyboard.type(" hey @Rowan"); await page.keyboard.press("Enter");
    await paste("AFTERCHIP");
    await expect(page.getByTestId("mention-chip")).toHaveCount(1);
    expect(await text()).toContain("AFTERCHIP");
    // select-all then paste replaces everything, chip included, and the task box disappears
    await page.keyboard.press("ControlOrMeta+A");
    await paste("only this");
    expect(await text()).toBe("only this");
    await expect(page.getByTestId("comment-task-box")).toHaveCount(0);
    // large paste
    await paste("Z".repeat(20000));
    expect((await text()).length).toBe(20009);
    // undo: informational only (Range insertion bypasses the native undo stack)
    await page.keyboard.press("ControlOrMeta+Z");
    finding("7a undo after paste", `text length after Ctrl+Z: ${(await text()).length}`);
    // the stored/serialised body reflects the DOM: submit it as a plain comment
    await editor.evaluate((el) => { el.innerHTML = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await editor.click();
    await paste("final pasted comment");
    await expect(page.getByRole("button", { name: "Comment", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByTestId("doc-comment-thread")).toContainText("final pasted comment", { timeout: 20_000 });
    expect(errors).toEqual([]);
  });

  test("7b arrowing in the picker never scrolls the page or the editor out of view; reply picker grows the thread without hiding Resolve/Delete", async ({ page, base }) => {
    test.setTimeout(240_000);
    await seedBulkMembers(4);
    watchConsole(page, "7b");
    await page.setViewportSize({ width: 390, height: 844 });
    await openDocWithSelection(page, base, `Scroll ${suffix}`, "XRAY");
    const editor = await startComment(page);
    await editor.click(); await page.keyboard.type("thread one"); await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByTestId("doc-comment-thread").first()).toBeVisible({ timeout: 20_000 });
    await openCommentsPanel(page);
    const listScroll = () => page.getByTestId("doc-comments-list").evaluate((el) => el.scrollTop);
    const reply = page.getByRole("textbox", { name: "Reply", exact: true });
    await reply.click(); await page.keyboard.type("@");
    await expect(page.getByTestId("mention-picker")).toBeVisible();
    const before = await listScroll();
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
    const after = await listScroll();
    const win = await page.evaluate(() => window.scrollY);
    finding("7b scroll", `thread-list scrollTop ${before} -> ${after}, window.scrollY ${win}`);
    const g = (await pickerGeometry(page))!;
    expect.soft(g.editorVisible, "reply editor stays on screen while arrowing").toBe(true);
    expect.soft(win, "window did not scroll").toBe(0);
    // Esc, then the thread's own buttons are reachable.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Resolve", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeInViewport();
  });

  test("7c unavailable-assignee cue and everything else on the card still renders", async ({ page, base }) => {
    test.setTimeout(240_000);
    const errors = watchConsole(page, "7c");
    await dockPanel(page);
    const docId = await openDocWithSelection(page, base, `Unavail ${suffix}`, "YANKEE");
    const editor = await startComment(page);
    await editor.click(); await page.keyboard.type("please @Wren"); await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Comment & create task" }).click();
    await expect(page.getByTestId("comment-task-card")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId("assignee-unavailable")).toHaveCount(0);
    await pool.query(`DELETE FROM "${S}".workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, wUserId]);
    try {
      if (process.env.QA_WAIT_MS) await page.waitForTimeout(Number(process.env.QA_WAIT_MS));
      await page.reload();
      await openCommentsPanel(page);
      const members = (await pool.query(`SELECT count(*)::int AS n FROM "${S}".workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, wUserId])).rows[0].n;
      const api = await page.request.get(`/api/panels/entity/task/${(await taskRows(docId))[0].id}?${query}`);
      const apiJson = JSON.stringify(await api.json()).match(/"assignee"[^}]*}/)?.[0] ?? "no assignee key";
      finding("7c api assignee", apiJson);
      const allRows = (await pool.query(`SELECT workspace_id, role FROM "${S}".workspace_members WHERE user_id = $1`, [wUserId])).rows;
      finding("7c all membership rows for W", JSON.stringify(allRows));
      const orgRows = (await pool.query(`SELECT role FROM "${S}".organization_members WHERE user_id = $1`, [wUserId])).rows;
      finding("7c org membership rows for W", JSON.stringify(orgRows));
      finding("7c debug", `membership rows=${members} card="${(await page.getByTestId("comment-task-card").innerText()).replace(/\s+/g, " ")}"`);
      await expect(page.getByTestId("assignee-unavailable")).toBeVisible();
      await expect(page.getByTestId("comment-task-card")).toContainText(/Unavailable person|Wren/);
      await shot(page, "reqa-7c-unavailable");
      // a revoked agent is flagged too
      await closeCommentsPanel(page);
    } finally {
      await pool.query(`INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT (workspace_id, user_id) DO NOTHING`, [workspaceId, wUserId]);
    }
    await page.reload();
    await openCommentsPanel(page);
    await expect(page.getByTestId("assignee-unavailable")).toHaveCount(0);
    expect((await taskRows(docId)).length).toBe(1);
    expect(errors).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (8) The popover is viewport-bounded and scrolls on phones; is the submit reachable by scrolling it?
  for (const size of [{ w: 390, h: 844 }, { w: 375, h: 667 }]) {
    test(`8 phone ${size.w}x${size.h}: submit stays reachable (not under the bottom nav) for 1 mention, 2 mentions, picker open`, async ({ page, base }) => {
      test.setTimeout(240_000);
      watchConsole(page, `8-${size.w}x${size.h}`);
      await page.setViewportSize({ width: size.w, height: size.h });
      await openDocWithSelection(page, base, `Reach ${size.w}x${size.h} ${suffix}`, "ZULU");
      const editor = await startComment(page);
      const probe = (label: string) => page.evaluate((l) => {
        const out: Record<string, string | number> = { label: l, vh: window.innerHeight };
        const pop = document.querySelector('[data-testid="new-comment-popover"]')!.getBoundingClientRect();
        out.popTop = Math.round(pop.top); out.popBottom = Math.round(pop.bottom);
        const nav = [...document.querySelectorAll("a")].find((a) => a.getAttribute("href")?.endsWith("/solutions"))?.closest("nav, div")?.getBoundingClientRect();
        out.navTop = nav ? Math.round(nav.top) : -1;
        for (const [key, sel] of [["submit", 'button:has-text("Comment")'], ["pickerFooter", '[data-testid="mention-picker"] kbd']] as const) {
          const el = [...document.querySelectorAll(sel.startsWith("button") ? "button" : sel)].filter((b) => sel.startsWith("button") ? /^Comment/.test(b.textContent ?? "") && !/Cancel/.test(b.textContent ?? "") : true).pop() as HTMLElement | undefined;
          if (!el) { out[key] = "absent"; continue; }
          // Reach it the way a person does: scroll the popover until the element is in view, then measure.
          el.scrollIntoView({ block: "nearest" });
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1));
          out[key] = `top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} covered=${hit && !el.contains(hit) ? (hit.closest("a")?.getAttribute("href") ?? hit.tagName) : "no"}`;
        }
        return out;
      }, label);
      await editor.click(); await page.keyboard.type("one @Rowan"); await page.keyboard.press("Enter");
      const one = await probe("one mention"); finding(`8 ${size.w}x${size.h}`, JSON.stringify(one));
      await page.keyboard.type("two @Wren"); await page.keyboard.press("Enter");
      const two = await probe("two mentions"); finding(`8 ${size.w}x${size.h}`, JSON.stringify(two));
      await page.keyboard.type("three @"); await expect(page.getByTestId("mention-picker")).toBeVisible();
      const open = await probe("two mentions + picker open"); finding(`8 ${size.w}x${size.h}`, JSON.stringify(open));
      await page.keyboard.press("Escape");
      await shot(page, `reqa-8-${size.w}x${size.h}`);
      for (const r of [one, two]) expect.soft(String(r.submit), `${size.w}x${size.h} ${r.label}: submit button covered by the bottom nav`).toContain("covered=no");
      expect.soft(String(open.pickerFooter) + String(open.pickerFooter), "picker footer reachable").not.toContain("covered=/");
    });
  }

});
