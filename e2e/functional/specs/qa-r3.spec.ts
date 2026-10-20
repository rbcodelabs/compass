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

test.describe("Re-QA 1a240774", () => {
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


  // ── round 3 helpers ──────────────────────────────────────────────────────
  /** Is the element's centre actually hit by a click (nothing like the bottom nav on top)? Scrolls inside the popover first. */
  async function reachability(page: Page, locatorText: RegExp) {
    return page.evaluate((src) => {
      const re = new RegExp(src);
      const pop = document.querySelector('[data-testid="new-comment-popover"]') as HTMLElement;
      const btn = [...pop.querySelectorAll("button")].filter((b) => re.test(b.textContent ?? "") && !/Cancel/.test(b.textContent ?? "")).pop() as HTMLElement | undefined;
      const info: Record<string, unknown> = { vh: window.innerHeight, vw: window.innerWidth, popMaxHeight: pop.style.maxHeight || "none", popScrollable: pop.scrollHeight > pop.clientHeight + 1 };
      if (!btn) return { ...info, found: false, btnTop: 0, btnBottom: 0, popTop: 0, popBottom: 0, inViewport: false, hitIsButton: false, hitBy: null as string | null };
      pop.scrollTop = pop.scrollHeight;
      btn.scrollIntoView({ block: "nearest" });
      const r = btn.getBoundingClientRect();
      const pr = pop.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const inViewport = r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
      const hit = cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight ? document.elementFromPoint(cx, cy) : null;
      return { ...info, found: true, btnTop: Math.round(r.top), btnBottom: Math.round(r.bottom), popTop: Math.round(pr.top), popBottom: Math.round(pr.bottom), inViewport, hitIsButton: !!hit && btn.contains(hit), hitBy: hit && !btn.contains(hit) ? (hit.closest("a")?.getAttribute("href") ?? hit.tagName) : null };
    }, locatorText.source);
  }

  async function addMention(page: Page, text: string) {
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  }

  const VIEWPORTS = [
    { name: "375x667", width: 375, height: 667 },
    { name: "390x844", width: 390, height: 844 },
    { name: "landscape 667x375", width: 667, height: 375 },
    { name: "small 320x568", width: 320, height: 568 },
    { name: "android+keyboard 360x420", width: 360, height: 420 },
  ];

  for (const vp of VIEWPORTS) {
    test(`R1 submit reachable by a real hit-test at ${vp.name}: 2 and 3 mentions, 70-char name, picker open/closed`, async ({ page, base }) => {
      test.setTimeout(240_000);
      const errors = watchConsole(page, `R1-${vp.name}`);
      const longName = "Wolfeschlegelsteinhausenbergerdorff".repeat(2) + ` ${suffix}`;
      await pool.query(`UPDATE "${S}".users SET name = $1 WHERE id = $2`, [longName, dUserId]);
      try {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const docId = await openDocWithSelection(page, base, `R1 ${vp.name} ${suffix}`, "ALFA");
        const editor = await startComment(page);
        await editor.click();
        const rec: string[] = [];
        const check = async (label: string, must = true) => {
          const r = await reachability(page, /^Comment/);
          rec.push(`${label}: ${JSON.stringify(r)}`);
          if (must) {
            expect.soft(r.found, `${vp.name} ${label}: submit exists`).toBe(true);
            expect.soft(r.inViewport, `${vp.name} ${label}: submit inside the viewport after scrolling the popover (${JSON.stringify(r)})`).toBe(true);
            expect.soft(r.hitIsButton, `${vp.name} ${label}: a tap at its centre lands on it, not ${r.hitBy} (${JSON.stringify(r)})`).toBe(true);
          }
        };
        await addMention(page, "two @Rowan");
        await check("1 mention");
        await addMention(page, "and @Wren");
        await check("2 mentions");
        await addMention(page, "and @Dale");
        await check("3 mentions incl. 70-char name");
        const longLabel = await page.evaluate(() => [...document.querySelectorAll('[data-testid="new-comment-popover"] *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5).map((el) => el.tagName + ":" + (el.textContent ?? "").slice(0, 25)));
        expect.soft(longLabel, `${vp.name}: nothing in the popover pokes past the right edge`).toEqual([]);
        await page.keyboard.type("more @");
        await expect(page.getByTestId("mention-picker")).toBeVisible();
        await check("3 mentions + picker open", false);
        const openR = await reachability(page, /^Comment/);
        expect.soft(openR.inViewport, `${vp.name}: submit reachable by scrolling inside the popover while the picker is open (${JSON.stringify(openR)})`).toBe(true);
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("mention-picker")).toBeHidden();
        for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace");
        finding(`R1 ${vp.name}`, rec.join(" || "));
        await shot(page, `r3-R1-${vp.name.replace(/\W+/g, "_")}`);
        const final = await reachability(page, /^Comment/);
        if (final.inViewport) {
          const box = await page.evaluate(() => {
            const pop = document.querySelector('[data-testid="new-comment-popover"]')!;
            const b = [...pop.querySelectorAll("button")].filter((x) => /^Comment/.test(x.textContent ?? "") && !/Cancel/.test(x.textContent ?? "")).pop()!;
            const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          });
          await page.mouse.click(box.x, box.y);
          await expect(page.getByTestId("doc-comment-thread").first()).toBeVisible({ timeout: 20_000 });
          expect((await commentIdsOf(docId)).length, "real tap posted exactly one comment").toBe(1);
        }
      } finally {
        await pool.query(`UPDATE "${S}".users SET name = $1 WHERE id = $2`, [dName, dUserId]);
      }
      expect(errors).toEqual([]);
    });
  }

  test("R1b rotate / resize while the popover is open (with and without the picker), and a taller bottom nav (safe-area approximation)", async ({ page, base }) => {
    test.setTimeout(300_000);
    watchConsole(page, "R1b");
    await page.setViewportSize({ width: 390, height: 844 });
    await openDocWithSelection(page, base, `Rotate ${suffix}`, "BRAVO");
    const editor = await startComment(page);
    await editor.click();
    await addMention(page, "one @Rowan"); await addMention(page, "two @Wren");
    const rec: string[] = [];
    const sizes: Array<[number, number]> = [[390, 844], [844, 390], [375, 667], [667, 375], [390, 844], [320, 480], [390, 844]];
    for (const [w, h] of sizes) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(250);
      const r = await reachability(page, /^Comment/);
      rec.push(`${w}x${h}: ${JSON.stringify(r)}`);
      expect.soft(r.inViewport && r.hitIsButton, `after resize to ${w}x${h}: submit reachable (${JSON.stringify(r)})`).toBe(true);
    }
    await editor.click(); await page.keyboard.press("End"); await page.keyboard.type(" @");
    await expect(page.getByTestId("mention-picker")).toBeVisible();
    for (const [w, h] of [[844, 390], [390, 844]] as Array<[number, number]>) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(250);
      const r = await reachability(page, /^Comment/);
      rec.push(`picker open ${w}x${h}: ${JSON.stringify(r)}`);
      expect.soft(r.inViewport, `picker open after resize to ${w}x${h}: submit reachable by scrolling the popover (${JSON.stringify(r)})`).toBe(true);
    }
    await page.keyboard.press("Escape");
    // Safe-area approximation: the bottom nav gains 34px of padding (env(safe-area-inset-bottom) cannot be set in headless).
    await page.setViewportSize({ width: 375, height: 667 });
    await page.evaluate(() => {
      const nav = [...document.querySelectorAll("a")].find((a) => a.getAttribute("href")?.endsWith("/solutions"))?.closest("nav, div") as HTMLElement | null;
      if (nav) { nav.style.paddingBottom = "34px"; nav.style.height = "auto"; }
    });
    await page.waitForTimeout(250);
    const withSafe = await page.evaluate(() => {
      const nav = [...document.querySelectorAll("a")].find((a) => a.getAttribute("href")?.endsWith("/solutions"))?.closest("nav, div") as HTMLElement | null;
      return nav ? Math.round(nav.getBoundingClientRect().top) : -1;
    });
    const r = await reachability(page, /^Comment/);
    rec.push(`safe-area-ish nav top=${withSafe}: ${JSON.stringify(r)}`);
    expect.soft(r.hitIsButton, `with a taller (safe-area) nav the submit is still not covered (${JSON.stringify(r)})`).toBe(true);
    finding("R1b rotate/resize", rec.join(" || "));
  });

  test("R2 long-name toggle label wraps inside the popover", async ({ page, base }) => {
    test.setTimeout(240_000);
    watchConsole(page, "R2");
    const longName = "Wolfeschlegelsteinhausenbergerdorff".repeat(2) + ` ${suffix}`;
    await pool.query(`UPDATE "${S}".users SET name = $1 WHERE id = $2`, [longName, bUserId]);
    try {
      for (const w of [320, 375, 390]) {
        await page.setViewportSize({ width: w, height: 800 });
        await openDocWithSelection(page, base, `Label ${w} ${suffix}`, "CHARLIE");
        const editor = await startComment(page);
        await editor.click(); await addMention(page, "@Wolfe");
        const m = await page.evaluate(() => {
          const label = [...document.querySelectorAll('[data-testid="comment-task-box"] b')].find((b) => /Assign as task/.test(b.textContent ?? "")) as HTMLElement;
          const pop = document.querySelector('[data-testid="new-comment-popover"]')!.getBoundingClientRect();
          const r = label.getBoundingClientRect();
          return { labelRight: Math.round(r.right), popRight: Math.round(pop.right), vw: window.innerWidth, h: Math.round(r.height) };
        });
        finding(`R2 label ${w}`, JSON.stringify(m));
        expect.soft(m.labelRight, `${w}px: label inside the popover`).toBeLessThanOrEqual(m.popRight);
        expect.soft(m.h, `${w}px: label wrapped onto several lines`).toBeGreaterThan(30);
        await page.keyboard.press("Escape");
      }
    } finally {
      await pool.query(`UPDATE "${S}".users SET name = $1 WHERE id = $2`, [bName, bUserId]);
    }
  });

  test("R3 unavailable assignee keeps the last known name (user removed, user with no name, agent grant revoked)", async ({ page, base, playwright }) => {
    test.setTimeout(300_000);
    const errors = watchConsole(page, "R3");
    await dockPanel(page);
    const mk = async (label: string, name: string | null) => {
      const email = `r3-${label}-${suffix}@localhost.dev`;
      const login = await playwright.request.newContext({ baseURL });
      const csrf = (await (await login.get("/api/auth/csrf")).json()) as { csrfToken: string };
      await login.post("/api/auth/callback/dev-credentials", { form: { csrfToken: csrf.csrfToken, email, callbackUrl: `${baseURL}/dashboard` }, maxRedirects: 0 });
      await login.dispose();
      const id = (await pool.query(`SELECT id FROM "${S}".users WHERE email = $1`, [email])).rows[0].id as string;
      await pool.query(`UPDATE "${S}".users SET name = $1 WHERE id = $2`, [name, id]);
      await pool.query(`INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW())`, [workspaceId, id]);
      return { id, email, name };
    };
    const named = await mk("named", `Zelda Leaver ${suffix}`);
    const nameless = await mk("nameless", null);
    const docId = await openDocWithSelection(page, base, `R3 ${suffix}`, "DELTA");
    const post = async (mention: string) => {
      await closeCommentsPanel(page);
      await page.locator(".ProseMirror").click();
      await selectLeadingWord(page, "DELTA");
      const e = await startComment(page);
      await e.click(); await addMention(page, `take this @${mention}`);
      await page.getByRole("button", { name: "Comment & create task" }).click();
      if (await page.getByTestId("agent-scope-confirm").isVisible().catch(() => false)) await page.getByTestId("confirm-agent-assign").click();
    };
    await post("Zelda");
    await expect(page.getByTestId("comment-task-card")).toHaveCount(1, { timeout: 20_000 });
    await post(nameless.email.slice(0, 12));
    await expect(page.getByTestId("comment-task-card")).toHaveCount(2, { timeout: 20_000 });
    await post("Adv Agent");
    await expect(page.getByTestId("comment-task-card")).toHaveCount(3, { timeout: 20_000 });
    await pool.query(`DELETE FROM "${S}".workspace_members WHERE workspace_id = $1 AND user_id = ANY($2)`, [workspaceId, [named.id, nameless.id]]);
    await pool.query(`UPDATE "${S}".agent_workspace_grants SET revoked_at = NOW() WHERE agent_id = $1 AND workspace_id = $2`, [agentId, workspaceId]);
    try {
      await page.waitForTimeout(1500);
      await page.reload();
      await openCommentsPanel(page);
      const cards = page.getByTestId("comment-task-card");
      await expect(cards).toHaveCount(3);
      const texts = (await cards.allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
      finding("R3 cards", texts.join(" || "));
      expect.soft(texts[0], "removed named user keeps their name").toContain(`Zelda Leaver ${suffix}`);
      expect.soft(texts[0]).toContain("Unavailable");
      expect.soft(texts[0]).not.toContain("Unavailable person");
      expect.soft(texts[1], "removed user with no name falls back to email").toContain(nameless.email);
      expect.soft(texts[1]).toContain("Unavailable");
      expect.soft(texts[2], "agent with a revoked grant keeps its name").toContain(agentName);
      expect.soft(texts[2]).toContain("Unavailable");
      await shot(page, "r3-R3-cards");
    } finally {
      await pool.query(`UPDATE "${S}".agent_workspace_grants SET revoked_at = NULL WHERE agent_id = $1 AND workspace_id = $2`, [agentId, workspaceId]);
    }
    expect(errors).toEqual([]);
    expect((await taskRows(docId)).length).toBe(3);
  });

  test("R4 real clipboard: Ctrl/Cmd+V then Ctrl/Cmd+Z undoes the paste (mid-text, selection replace, chip neighbour, multi-line, markup)", async ({ page, base, context }) => {
    test.setTimeout(240_000);
    const errors = watchConsole(page, "R4");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
    await dockPanel(page);
    const docId = await openDocWithSelection(page, base, `R4 ${suffix}`, "ECHO");
    const editor = await startComment(page);
    await editor.click();
    const text = () => editor.evaluate((el) => el.textContent ?? "");
    const clip = (t: string) => page.evaluate((v) => navigator.clipboard.writeText(v), t);
    const rec: string[] = [];
    await page.keyboard.type("start end");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
    await clip("MID ");
    await page.keyboard.press("ControlOrMeta+V");
    expect(await text()).toBe("start MID end");
    await page.keyboard.press("ControlOrMeta+Z");
    rec.push(`mid-text undo -> "${await text()}"`);
    expect.soft(await text(), "undo takes back the mid-text paste").toBe("start end");
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    rec.push(`redo -> "${await text()}"`);
    expect.soft(await text(), "redo puts it back").toBe("start MID end");
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
    await clip("REPL ");
    await page.keyboard.press("ControlOrMeta+V");
    expect(await text()).toBe("start REPL end");
    await page.keyboard.press("ControlOrMeta+Z");
    rec.push(`selection-replace undo -> "${await text()}"`);
    expect.soft(await text(), "undo restores the replaced selection").toBe("start MID end");
    await page.keyboard.press("End");
    await clip("<b>bold</b> x @Rowan\nsecond");
    await page.keyboard.press("ControlOrMeta+V");
    await expect(page.getByTestId("mention-picker")).toBeHidden();
    expect(await editor.evaluate((el) => el.querySelectorAll("b").length)).toBe(0);
    expect(await text()).toContain("<b>bold</b> x @Rowan");
    await page.keyboard.press("ControlOrMeta+Z");
    rec.push(`multi-line undo -> "${await text()}"`);
    expect.soft(await text(), "undo takes back the multi-line paste").toBe("start MID end");
    await page.keyboard.type(" hey @Rowan"); await page.keyboard.press("Enter");
    await expect(page.getByTestId("mention-chip")).toHaveCount(1);
    await clip("AFTER");
    await page.keyboard.press("ControlOrMeta+V");
    expect(await text()).toContain("AFTER");
    await page.keyboard.press("ControlOrMeta+Z");
    rec.push(`chip-neighbour undo -> "${await text()}" chips=${await page.getByTestId("mention-chip").count()}`);
    expect.soft(await text()).not.toContain("AFTER");
    await expect.soft(page.getByTestId("mention-chip"), "the chip survives undoing the paste after it").toHaveCount(1);
    for (let i = 0; i < 6; i++) await page.keyboard.press("ControlOrMeta+Z");
    const afterMany = { text: await text(), chips: await page.getByTestId("mention-chip").count(), taskBox: await page.getByTestId("comment-task-box").count() };
    rec.push(`6 more undos -> ${JSON.stringify(afterMany)}`);
    expect.soft(afterMany.chips > 0, "task box tracks the chips after repeated undo").toBe(afterMany.taskBox > 0);
    await editor.evaluate((el) => { el.innerHTML = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await editor.click();
    await clip("final pasted comment");
    await page.keyboard.press("ControlOrMeta+V");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByTestId("doc-comment-thread")).toContainText("final pasted comment", { timeout: 20_000 });
    const body = (await pool.query(`SELECT body FROM "${S}".doc_comments WHERE doc_id = $1`, [docId])).rows[0].body as string;
    expect(body).toBe("final pasted comment");
    finding("R4 paste/undo", rec.join(" | "));
    expect(errors).toEqual([]);
  });

  test("R5 landscape phone 667x375 and 844x390: can a thumb reach submit by scrolling the page/popover with the wheel?", async ({ page, base }) => {
    test.setTimeout(240_000);
    watchConsole(page, "R5");
    for (const [w, h] of [[667, 375], [844, 390], [1024, 400]] as Array<[number, number]>) {
      await page.setViewportSize({ width: w, height: h });
      await openDocWithSelection(page, base, `Land ${w} ${suffix}`, "FOXTROT");
      const editor = await startComment(page);
      await editor.click(); await addMention(page, "one @Rowan");
      const box = await page.getByTestId("new-comment-popover").boundingBox();
      const before = await reachability(page, /^Comment/);
      const probe = () => page.evaluate(() => {
        const pop = document.querySelector('[data-testid="new-comment-popover"]')!;
        const b = [...pop.querySelectorAll("button")].filter((x) => /^Comment/.test(x.textContent ?? "") && !/Cancel/.test(x.textContent ?? "")).pop()!;
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1));
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, visible: r.top >= 0 && r.bottom <= window.innerHeight, hitIsButton: b.contains(hit) };
      });
      await page.mouse.move(box!.x + 20, box!.y + 20);
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(120); }
      const afterPopWheel = await probe();
      await page.mouse.move(60, h - 60);
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(120); }
      const afterPageWheel = await probe();
      finding(`R5 ${w}x${h}`, JSON.stringify({ popoverBox: box, before, afterPopWheel, afterPageWheel }));
      expect.soft(afterPopWheel.visible && afterPopWheel.hitIsButton || afterPageWheel.visible && afterPageWheel.hitIsButton, `${w}x${h}: submit becomes reachable by wheel scrolling (${JSON.stringify({ afterPopWheel, afterPageWheel })})`).toBe(true);
      await page.keyboard.press("Escape");
    }
  });

});
