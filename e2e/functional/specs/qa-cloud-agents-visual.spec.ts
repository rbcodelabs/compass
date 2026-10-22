/**
 * QA pass for cloud agents: visual evidence at 1440 and 390 plus the real flows.
 * Screenshots go to QA_SHOTS_DIR. Not a regression spec; it is the QA harness for the phase 2-5 PR.
 */
import { test, expect } from "../fixtures/index";
import type { Page, BrowserContext } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createOpportunityFromBoard } from "../fixtures/opportunity-composer";

const S = "compass_dev";
const ORG = "e2e-test-org";
const WS = "e2e-workspace";
const SHOTS = process.env.QA_SHOTS_DIR ?? "/tmp/qa-shots";
const VIEWPORTS = [{ w: 1440, h: 900 }, { w: 390, h: 844 }];

test.describe("QA cloud agents", () => {
  test.describe.configure({ mode: "serial" });
  const suffix = randomUUID().slice(0, 6);
  const shared = `Shared triage agent with a deliberately long name to test wrapping ${suffix}`;
  const personal = `Mine ${suffix}`;
  const gated = `Admins-only ${suffix}`;
  let pool: pg.Pool;
  let workspaceId = "";
  const toast = (page: Page, text: string | RegExp) => page.getByTestId("undo-toast").filter({ hasText: text });
  const consoleErrors: string[] = [];
  const overflowNotes: string[] = [];

  async function shot(page: Page, name: string) {
    fs.mkdirSync(SHOTS, { recursive: true });
    const w = page.viewportSize()!.width;
    await page.screenshot({ path: path.join(SHOTS, `${name}-${w}.png`), fullPage: true });
  }
  async function checkOverflow(page: Page, label: string) {
    const w = page.viewportSize()!.width;
    const res = await page.evaluate(() => {
      const iw = window.innerWidth;
      const bad: string[] = [];
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > iw + 1 || r.left < -1) {
          // ignore anything inside a horizontally scrollable ancestor
          let p = el.parentElement; let scroll = false;
          while (p && p !== document.body) { const ox = getComputedStyle(p).overflowX; if ((ox === "auto" || ox === "scroll") && p.scrollWidth > p.clientWidth) { scroll = true; break; } p = p.parentElement; }
          if (!scroll) bad.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 60)} right=${Math.round(r.right)}`);
        }
      }
      return { scrollWidth: document.documentElement.scrollWidth, iw, bad: bad.slice(0, 6) };
    });
    if (res.scrollWidth > res.iw || res.bad.length) overflowNotes.push(`${label}@${w}: scrollWidth=${res.scrollWidth} innerWidth=${res.iw} offenders=${JSON.stringify(res.bad)}`);
  }
  async function snap(page: Page, name: string) { await checkOverflow(page, name); await shot(page, name); }
  async function setVp(page: Page, i: number) { await page.setViewportSize({ width: VIEWPORTS[i].w, height: VIEWPORTS[i].h }); }

  test.beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    workspaceId = (await pool.query(`SELECT w.id FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id=w.organization_id WHERE o.slug=$1 AND w.slug=$2`, [ORG, WS])).rows[0].id;
    await pool.query(`INSERT INTO ${S}.agent_runtime_config (scope, golden_snapshot_id, updated_at) VALUES ('global','e2e-placeholder-snapshot',now()) ON CONFLICT (scope) DO UPDATE SET golden_snapshot_id=EXCLUDED.golden_snapshot_id`);
  });

  test.afterAll(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, "overflow-notes.txt"), overflowNotes.join("\n") + "\n--console--\n" + consoleErrors.join("\n"));
    const ids = (await pool.query(`SELECT id FROM ${S}.agents WHERE name = ANY($1::text[])`, [[shared, personal, gated]])).rows.map((r) => r.id);
    if (ids.length) {
      const convs = (await pool.query(`SELECT DISTINCT conversation_id FROM ${S}.agent_runs WHERE agent_id = ANY($1::uuid[])`, [ids])).rows.map((r) => r.conversation_id).filter(Boolean);
      await pool.query(`DELETE FROM ${S}.agent_run_events WHERE run_id IN (SELECT id FROM ${S}.agent_runs WHERE agent_id = ANY($1::uuid[]))`, [ids]).catch(() => undefined);
      await pool.query(`DELETE FROM ${S}.agent_runs WHERE agent_id = ANY($1::uuid[])`, [ids]);
      if (convs.length) { await pool.query(`DELETE FROM ${S}.agent_messages WHERE conversation_id = ANY($1::uuid[])`, [convs]); await pool.query(`DELETE FROM ${S}.agent_conversations WHERE id = ANY($1::uuid[])`, [convs]); }
      await pool.query(`DELETE FROM ${S}.api_keys WHERE agent_id = ANY($1::uuid[])`, [ids]).catch(() => undefined);
      await pool.query(`DELETE FROM ${S}.tasks WHERE assignee_agent_id = ANY($1::uuid[])`, [ids]);
      await pool.query(`DELETE FROM ${S}.workspace_default_agents WHERE agent_id = ANY($1::uuid[])`, [ids]).catch(() => undefined);
      await pool.query(`DELETE FROM ${S}.user_default_agents WHERE agent_id = ANY($1::uuid[])`, [ids]).catch(() => undefined);
      await pool.query(`DELETE FROM ${S}.agent_tool_calls WHERE agent_id = ANY($1::uuid[])`, [ids]);
      await pool.query(`DELETE FROM ${S}.agent_workspace_grants WHERE agent_id = ANY($1::uuid[])`, [ids]);
      await pool.query(`DELETE FROM ${S}.agents WHERE id = ANY($1::uuid[])`, [ids]);
    }
    await pool.query(`DELETE FROM ${S}.docs WHERE title LIKE $1`, [`QA mention doc ${suffix}%`]).catch(() => undefined);
    await pool.end();
  });

  test.beforeEach(({ page }) => {
    page.on("console", (m) => { const t = m.text(); if (m.type() === "error" && !t.startsWith("Failed to load resource")) consoleErrors.push(`[${test.info().title}] ${t}`); });
    page.on("pageerror", (e) => consoleErrors.push(`[${test.info().title}] pageerror ${e.message}`));
  });

  test("1 settings: create shared + personal, list, badges, default, edit with caps, clear default (1440 then 390)", async ({ page, base }) => {
    test.setTimeout(240_000);
    await setVp(page, 0);
    await page.goto(`${base}/settings`);
    const heading = page.getByRole("heading", { name: "Workspace agents", exact: true });
    await heading.scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "New cloud agent" }).click();
    const form = page.getByRole("form", { name: "New cloud agent" });
    await expect(form.getByLabel("Owner")).toBeVisible();
    await form.getByLabel("Owner").selectOption("WORKSPACE");
    await form.getByLabel("Agent name").fill(shared);
    await form.getByLabel("Instructions").fill("Triage incoming feedback.");
    await snap(page, "settings-new-form-shared");
    await form.getByRole("button", { name: "Create agent" }).click();
    await expect(page.getByText("Agent created and enabled in this workspace.")).toBeVisible({ timeout: 20_000 });
    // personal
    await page.getByRole("button", { name: "New cloud agent" }).click();
    const form2 = page.getByRole("form", { name: "New cloud agent" });
    await form2.getByLabel("Owner").selectOption("USER");
    await form2.getByLabel("Agent name").fill(personal);
    await form2.getByLabel("Instructions").fill("My private helper.");
    await form2.getByRole("button", { name: "Create agent" }).click();
    await expect(page.locator("li").filter({ hasText: personal })).toBeVisible({ timeout: 20_000 });
    // admins-only shared agent (for the not-invokable toast)
    await page.getByRole("button", { name: "New cloud agent" }).click();
    const form3 = page.getByRole("form", { name: "New cloud agent" });
    await form3.getByLabel("Owner").selectOption("WORKSPACE");
    await form3.getByLabel("Agent name").fill(gated);
    await form3.getByLabel("Who can run this agent").selectOption("ADMINS");
    await form3.getByRole("button", { name: "Create agent" }).click();
    await expect(page.locator("li").filter({ hasText: gated })).toBeVisible({ timeout: 20_000 });

    for (let i = 0; i < 2; i++) {
      await setVp(page, i);
      await page.goto(`${base}/settings`);
      await heading.scrollIntoViewIfNeeded();
      const row = page.locator("li").filter({ hasText: shared });
      const prow = page.locator("li").filter({ hasText: personal });
      await expect(row.getByText("Cloud", { exact: true })).toBeVisible();
      await expect(row.getByText("Shared", { exact: true }).first()).toBeVisible();
      await expect(prow.getByText("Personal", { exact: true }).first()).toBeVisible();
      await snap(page, "settings-list");
      // set workspace default (idempotent per iteration)
      if (await row.getByRole("button", { name: "Set as workspace default" }).count()) await row.getByRole("button", { name: "Set as workspace default" }).click();
      await expect(row.getByText("Workspace default", { exact: true })).toBeVisible({ timeout: 15_000 });
      if (await prow.getByRole("button", { name: "Use as my default" }).count()) await prow.getByRole("button", { name: "Use as my default" }).click();
      await expect(prow.getByText("My default", { exact: true })).toBeVisible({ timeout: 15_000 });
      await snap(page, "settings-defaults-set");
      // edit form with caps
      await row.getByRole("button", { name: `Edit ${shared}` }).click();
      const edit = page.getByRole("form", { name: `Edit ${shared}` });
      await expect(edit.getByLabel("Concurrent run limit")).toBeVisible();
      await expect(edit.getByLabel("Daily run limit")).toBeVisible();
      await edit.getByLabel("Concurrent run limit").fill(i === 0 ? "3" : "4");
      await snap(page, "settings-edit-form-caps");
      await edit.getByRole("button", { name: "Save agent" }).click();
      await expect(page.getByRole("form", { name: `Edit ${shared}` })).toHaveCount(0, { timeout: 15_000 });
      const cap = (await pool.query(`SELECT max_concurrent_runs FROM ${S}.agents WHERE name=$1`, [shared])).rows[0].max_concurrent_runs;
      expect(cap).toBe(i === 0 ? 3 : 4);
      // clear defaults
      await row.getByRole("button", { name: "Clear workspace default" }).click();
      await expect(row.getByText("Workspace default", { exact: true })).toHaveCount(0, { timeout: 15_000 });
      await prow.getByRole("button", { name: "Clear my default" }).click();
      await expect(prow.getByText("My default", { exact: true })).toHaveCount(0, { timeout: 15_000 });
      await snap(page, "settings-defaults-cleared");
    }
    // leave workspace default = shared at the end
    await page.locator("li").filter({ hasText: shared }).getByRole("button", { name: "Set as workspace default" }).click();
    await expect(page.locator("li").filter({ hasText: shared }).getByText("Workspace default", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.locator("li").filter({ hasText: personal }).getByRole("button", { name: "Use as my default" }).click();
    await expect(page.locator("li").filter({ hasText: personal }).getByText("My default", { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test("2 account My agents panel", async ({ page }) => {
    test.setTimeout(120_000);
    for (let i = 0; i < 2; i++) {
      await setVp(page, i);
      await page.goto("/settings/agents");
      await expect(page.getByRole("heading", { name: "My agents" })).toBeVisible();
      await expect(page.getByText(personal).first()).toBeVisible();
      await snap(page, "account-agents");
      const edit = page.getByRole("button", { name: `Edit ${personal}` });
      if (await edit.count()) { await edit.click(); await snap(page, "account-agents-edit"); await page.getByRole("button", { name: "Close" }).first().click().catch(() => undefined); }
    }
  });

  test("3 chat Agent selector", async ({ page, base }) => {
    test.setTimeout(120_000);
    for (let i = 0; i < 2; i++) {
      await setVp(page, i);
      await page.goto(`${base}/agent`);
      const menu = page.getByLabel("Agent", { exact: true });
      await expect(menu).toBeVisible({ timeout: 15_000 });
      const options = await menu.locator("option").allInnerTexts();
      fs.mkdirSync(SHOTS, { recursive: true });
      fs.appendFileSync(path.join(SHOTS, "chat-options.txt"), `${VIEWPORTS[i].w}: ${JSON.stringify(options)}\n`);
      await snap(page, "chat-agent-selector");
    }
  });

  test("4 assignee picker shows cloud agents", async ({ page, base }) => {
    test.setTimeout(120_000);
    for (let i = 0; i < 2; i++) {
      await setVp(page, i);
      await page.goto(`${base}/tasks`);
      const todo = page.locator('[data-task-column="TODO"]');
      await todo.getByRole("button", { name: /Add task/i }).first().click();
      await page.getByLabel("Title", { exact: true }).fill(`QA picker ${suffix}`);
      await page.getByLabel("Assignee (optional)").click();
      await expect(page.getByRole("option", { name: new RegExp(personal) })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("option", { name: new RegExp(shared.slice(0, 30)) })).toBeVisible();
      await snap(page, "assignee-picker");
    }
  });

  async function addTask(page: Page, base: string, title: string, agent: string) {
    await page.goto(`${base}/tasks`);
    const todo = page.locator('[data-task-column="TODO"]');
    await todo.getByRole("button", { name: /Add task/i }).first().click();
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByLabel("Assignee (optional)").click();
    await page.getByRole("option", { name: new RegExp(agent.slice(0, 30)) }).click();
    await todo.getByRole("button", { name: "Add Task", exact: true }).click();
  }

  test("5 assignment toasts: started, cap reached, then personal started at 390", async ({ page, base }) => {
    test.setTimeout(240_000);
    await setVp(page, 0);
    const t1 = `QA assign one ${suffix}`;
    await addTask(page, base, t1, shared);
    await expect(toast(page, "Started a run as")).toBeVisible({ timeout: 20_000 });
    await shot(page, "toast-started");
    const agentId = (await pool.query(`SELECT id FROM ${S}.agents WHERE name=$1`, [shared])).rows[0].id as string;
    const run = (await pool.query(`SELECT status, agent_id, invoked_by_user_id, claim_id FROM ${S}.agent_runs WHERE agent_id=$1`, [agentId])).rows;
    expect(run.length).toBe(1);
    expect(run[0].invoked_by_user_id).toBeTruthy();
    await expect.poll(async () => (await pool.query(`SELECT status || ':' || coalesce(error_code,'') AS s FROM ${S}.agent_runs WHERE agent_id=$1`, [agentId])).rows[0]?.s, { timeout: 60_000 }).not.toMatch(/^QUEUED/);
    fs.appendFileSync(path.join(SHOTS, "run-final.txt"), JSON.stringify((await pool.query(`SELECT status, error_code, agent_id, invoked_by_user_id FROM ${S}.agent_runs WHERE agent_id=$1`, [agentId])).rows) + "\n");
    // cap via UI
    await page.goto(`${base}/settings`);
    await page.getByRole("heading", { name: "Workspace agents", exact: true }).scrollIntoViewIfNeeded();
    const row = page.locator("li").filter({ hasText: shared });
    await row.getByRole("button", { name: `Edit ${shared}` }).click();
    const edit = page.getByRole("form", { name: `Edit ${shared}` });
    await edit.getByLabel("Daily run limit").fill("1");
    await edit.getByRole("button", { name: "Save agent" }).click();
    await expect(page.getByRole("form", { name: `Edit ${shared}` })).toHaveCount(0, { timeout: 15_000 });
    await addTask(page, base, `QA assign two ${suffix}`, shared);
    await expect(toast(page, /no run started/)).toBeVisible({ timeout: 20_000 });
    await shot(page, "toast-cap-desktop");
    fs.appendFileSync(path.join(SHOTS, "toast-texts.txt"), `cap: ${await toast(page, /no run started/).innerText()}\n`);
    expect((await pool.query(`SELECT count(*)::int n FROM ${S}.agent_runs WHERE agent_id=$1`, [agentId])).rows[0].n).toBe(1);
    // mobile
    await setVp(page, 1);
    await addTask(page, base, `QA assign three ${suffix}`, shared);
    await expect(toast(page, /no run started/)).toBeVisible({ timeout: 20_000 });
    await shot(page, "toast-cap-mobile");
    await addTask(page, base, `QA assign four ${suffix}`, personal);
    await expect(toast(page, "Started a run as")).toBeVisible({ timeout: 20_000 });
    await shot(page, "toast-started-mobile");
    fs.appendFileSync(path.join(SHOTS, "toast-texts.txt"), `started: ${await toast(page, "Started a run as").innerText()}\n`);
    const pAgentId = (await pool.query(`SELECT id FROM ${S}.agents WHERE name=$1`, [personal])).rows[0].id as string;
    expect((await pool.query(`SELECT count(*)::int n FROM ${S}.agent_runs WHERE agent_id=$1`, [pAgentId])).rows[0].n).toBe(1);
  });

  test("6 not-invokable toast as a plain member", async ({ browser, playwright, base }) => {
    test.setTimeout(180_000);
    const baseURL = test.info().project.use.baseURL as string;
    const email = `qa-member-${suffix}@localhost.dev`;
    const login = await playwright.request.newContext({ baseURL });
    const csrf = (await (await login.get("/api/auth/csrf")).json()) as { csrfToken: string };
    await login.post("/api/auth/callback/dev-credentials", { form: { csrfToken: csrf.csrfToken, email, callbackUrl: `${baseURL}/dashboard` }, maxRedirects: 0 });
    const uid = (await pool.query(`SELECT id FROM ${S}.users WHERE email=$1`, [email])).rows[0].id;
    await pool.query(`INSERT INTO ${S}.workspace_members (id, workspace_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT (workspace_id, user_id) DO NOTHING`, [workspaceId, uid]);
    const ctx: BrowserContext = await browser.newContext({ storageState: await login.storageState(), baseURL });
    const page = await ctx.newPage();
    try {
      for (let i = 0; i < 2; i++) {
        await setVp(page, i);
        await page.goto(`${base}/tasks`);
        const todo = page.locator('[data-task-column="TODO"]');
        await todo.getByRole("button", { name: /Add task/i }).first().click();
        await page.getByLabel("Title", { exact: true }).fill(`QA gated ${i} ${suffix}`);
        await page.getByLabel("Assignee (optional)").click();
        const opt = page.getByRole("option", { name: new RegExp(gated) });
        const listed = await opt.count();
        fs.appendFileSync(path.join(SHOTS, "member-picker.txt"), `${VIEWPORTS[i].w}: admins-only agent listed for member = ${listed}\n`);
        await shot(page, "member-assignee-picker");
        if (!listed) break;
        await opt.click();
        await todo.getByRole("button", { name: "Add Task", exact: true }).click();
        await expect(toast(page, /not allowed to run it/)).toBeVisible({ timeout: 20_000 });
        await shot(page, "toast-not-invokable");
        fs.appendFileSync(path.join(SHOTS, "toast-texts.txt"), `not-invokable: ${await toast(page, /not allowed/).innerText()}\n`);
      }
      const gid = (await pool.query(`SELECT id FROM ${S}.agents WHERE name=$1`, [gated])).rows[0].id;
      expect((await pool.query(`SELECT count(*)::int n FROM ${S}.agent_runs WHERE agent_id=$1`, [gid])).rows[0].n).toBe(0);
    } finally {
      await pool.query(`DELETE FROM ${S}.tasks WHERE title LIKE $1`, [`QA gated % ${suffix}`]);
      await pool.query(`DELETE FROM ${S}.workspace_members WHERE user_id=$1`, [uid]);
      await ctx.close(); await login.dispose();
    }
  });

  test("7 Send to agent menu on an approved solution plan", async ({ page, base }) => {
    test.setTimeout(240_000);
    await setVp(page, 0);
    const oppTitle = `QA Opp ${suffix}`; const solTitle = `QA Sol ${suffix}`;
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await createOpportunityFromBoard(page, oppTitle);
    await page.getByRole("button", { name: oppTitle, exact: true }).click();
    const href = await page.getByRole("link", { name: "Open full page" }).getAttribute("href");
    await page.goto(new URL(href!, page.url()).toString());
    await page.getByRole("button", { name: "Add Solution" }).click();
    await page.getByLabel("Title").fill(solTitle);
    await page.getByRole("button", { name: "Add Solution" }).last().click();
    const detailUrl = page.url();
    for (let i = 0; i < 2; i++) {
      await setVp(page, i);
      if (i === 1) await page.goto(detailUrl);
      await page.getByRole("button", { name: solTitle, exact: true }).click();
      const panel = page.locator('[data-slot="sheet-content"]');
      await expect(panel).toBeVisible();
      if (i === 0) {
        await panel.getByRole("button", { name: "Add Plan Update" }).click();
        await panel.getByPlaceholder("Write a plan update…").fill("QA plan: do the thing");
        await panel.getByRole("button", { name: "Post plan update" }).click();
        await panel.getByTestId("current-plan").getByRole("button", { name: "Approve" }).click();
        await expect(panel.getByTestId("plan-status-badge")).toHaveText("Approved", { timeout: 10_000 });
      }
      const send = panel.getByText("Send to agent").first();
      await expect(send).toBeVisible({ timeout: 10_000 });
      await send.click();
      await page.waitForTimeout(500);
      await shot(page, "send-to-agent-menu");
      const menuText = await page.locator('[role="menu"]').allInnerTexts();
      fs.appendFileSync(path.join(SHOTS, "send-to-agent-menu.txt"), `${VIEWPORTS[i].w}: ${JSON.stringify(menuText)}\n`);
      await checkOverflow(page, "send-to-agent-menu");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    }
    await pool.query(`DELETE FROM ${S}.opportunities WHERE title=$1`, [oppTitle]).catch(() => undefined);
  });

  test("8 @mention doc comment on a cloud agent creates a task and starts an attributed run", async ({ page, base }) => {
    test.setTimeout(240_000);
    await setVp(page, 0);
    await page.context().addCookies([{ name: "compass_panel_docsComments", value: "1:440", url: test.info().project.use.baseURL as string }]);
    const docId = randomUUID();
    await pool.query(`INSERT INTO ${S}.docs (id, workspace_id, title, content, sort_order, doc_type, created_at, updated_at) VALUES ($1,$2,$3,$4,9000,'STANDARD',NOW(),NOW())`, [docId, workspaceId, `QA mention doc ${suffix}`, `REVIEW the rollout checklist needs an owner`]);
    await page.goto(`${base}/docs/${docId}`);
    const editor = page.locator(".ProseMirror");
    await expect(editor).toContainText("REVIEW", { timeout: 60_000 });
    await editor.click();
    await expect(async () => {
      await page.evaluate(() => {
        const walker = document.createTreeWalker(document.querySelector(".ProseMirror p")!, NodeFilter.SHOW_TEXT);
        const first = walker.nextNode() as Text; const range = document.createRange(); range.setStart(first, 0); range.setEnd(first, 6);
        const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
      });
      await expect(page.getByTitle("Comment on selection")).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await page.getByTitle("Comment on selection").click();
    const box = page.getByRole("textbox", { name: "Comment", exact: true });
    await box.click();
    await page.keyboard.type(`Please summarise @Mine`);
    const picker = page.getByTestId("mention-picker");
    await expect(picker).toBeVisible();
    await shot(page, "mention-picker");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("mention-chip")).toBeVisible();
    await page.getByRole("button", { name: "Comment & create task" }).click();
    const confirm = page.getByTestId("agent-scope-confirm");
    if (await confirm.count()) { await shot(page, "mention-scope-confirm"); await page.getByTestId("confirm-agent-assign").click(); }
    const card = page.getByTestId("comment-task-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await shot(page, "mention-task-card");
    const aid = (await pool.query(`SELECT id FROM ${S}.agents WHERE name=$1`, [personal])).rows[0].id;
    const t = (await pool.query(`SELECT t.assignee_agent_id FROM ${S}.tasks t JOIN ${S}.task_links l ON l.task_id=t.id WHERE l.linked_type='DOC' AND l.linked_id=$1`, [docId])).rows;
    expect(t).toEqual([{ assignee_agent_id: aid }]);
    const runs = (await pool.query(`SELECT status, error_code FROM ${S}.agent_runs WHERE agent_id=$1`, [aid])).rows;
    fs.appendFileSync(path.join(SHOTS, "run-final.txt"), `mention runs: ${JSON.stringify(runs)}\n`);
    const toasts = await page.getByTestId("undo-toast").allInnerTexts();
    fs.appendFileSync(path.join(SHOTS, "toast-texts.txt"), `mention toasts: ${JSON.stringify(toasts)}\n`);
    await shot(page, "mention-after");
    await pool.query(`DELETE FROM ${S}.task_links WHERE linked_type='DOC' AND linked_id=$1`, [docId]);
  });
});
