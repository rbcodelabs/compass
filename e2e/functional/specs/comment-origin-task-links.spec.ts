/**
 * Comment-origin task links (`TASK_CREATED_FROM` with `linkedType = "COMMENT"`):
 *  1. Non-Doc Discussion comments render descriptive `Comment on OPP-<n>: "<excerpt>"`
 *     labels inside a protected `Created from` block (no destructive `×` unlink button),
 *     and clicking navigates to the parent object and focuses/expands the comment thread
 *     even when resolved.
 *  2. Doc comments render `Comment on “<anchor>”` inside `Created from` (no `×` button),
 *     and clicking navigates to the Doc, opens the Comments panel, reveals resolved threads
 *     when the task is Done, and highlights the originating comment.
 */
import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import type { Page } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";

test.describe("Comment-origin task links (descriptive, clickable, protected provenance)", () => {
  test.describe.configure({ mode: "serial" });

  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  const memberEmail = `origin-link-${suffix}@localhost.dev`;
  const memberName = `OriginAssignee${suffix}`;

  let pool: pg.Pool;
  let workspaceId = "";
  let memberUserId = "";
  const createdOppIds: string[] = [];
  const createdDocIds: string[] = [];
  const createdTaskIds: string[] = [];

  /** Select the leading word of the first ProseMirror paragraph reliably. */
  async function selectLeadingWord(page: Page, word: string) {
    await expect(async () => {
      await page.evaluate((w) => {
        const walker = document.createTreeWalker(document.querySelector(".ProseMirror p")!, NodeFilter.SHOW_TEXT);
        const first = walker.nextNode() as Text;
        const range = document.createRange();
        range.setStart(first, 0);
        let remaining = w.length;
        for (let node: Text | null = first; node; node = walker.nextNode() as Text | null) {
          if (node.length >= remaining) {
            range.setEnd(node, remaining);
            break;
          }
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

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(120_000);
    pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
    const baseURL = test.info().project.use.baseURL as string;
    const login = await playwright.request.newContext({ baseURL });
    const csrf = (await (await login.get("/api/auth/csrf")).json()) as { csrfToken: string };
    const signedIn = await login.post("/api/auth/callback/dev-credentials", {
      form: { csrfToken: csrf.csrfToken, email: memberEmail, callbackUrl: `${baseURL}/dashboard` },
      maxRedirects: 0,
    });
    expect([200, 302]).toContain(signedIn.status());
    await login.dispose();

    await pool.query(`UPDATE "${S}".users SET name = $1 WHERE email = $2`, [memberName, memberEmail]);
    memberUserId = (await pool.query<{ id: string }>(`SELECT id FROM "${S}".users WHERE email = $1`, [memberEmail])).rows[0].id;
    const {
      rows: [ws],
    } = await pool.query<{ id: string }>(
      `SELECT w.id FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $1 AND w.slug = $2`,
      [ORG, WORKSPACE],
    );
    workspaceId = ws.id;
    await pool.query(
      `INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, memberUserId],
    );
  });

  test.afterAll(async () => {
    if (!pool) return;
    for (const taskId of createdTaskIds) {
      await pool.query(`DELETE FROM "${S}".entity_links WHERE from_type = 'TASK' AND from_id = $1`, [taskId]).catch(() => undefined);
      await pool.query(`DELETE FROM "${S}".tasks WHERE id = $1`, [taskId]).catch(() => undefined);
    }
    for (const oppId of createdOppIds) {
      await pool.query(`DELETE FROM "${S}".comments WHERE target_type = 'OPPORTUNITY' AND target_id = $1`, [oppId]).catch(() => undefined);
      await pool.query(`DELETE FROM "${S}".opportunities WHERE id = $1`, [oppId]).catch(() => undefined);
    }
    for (const docId of createdDocIds) {
      await pool.query(`DELETE FROM "${S}".doc_comment_anchors WHERE comment_id IN (SELECT id FROM "${S}".comments WHERE target_type = 'DOC' AND target_id = $1)`, [docId]).catch(() => undefined);
      await pool.query(`DELETE FROM "${S}".doc_comments WHERE doc_id = $1`, [docId]).catch(() => undefined);
      await pool.query(`DELETE FROM "${S}".comments WHERE target_type = 'DOC' AND target_id = $1`, [docId]).catch(() => undefined);
      await pool.query(`DELETE FROM "${S}".docs WHERE id = $1`, [docId]).catch(() => undefined);
    }
    await pool.query(`DELETE FROM "${S}".workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, memberUserId]).catch(() => undefined);
    await pool.end();
  });

  test("Discussion comment -> Task: shows descriptive OPP-<n> excerpt in Created from without unlink button and deep-links to resolved comment", async ({ page, base }) => {
    test.setTimeout(120_000);
    const oppId = randomUUID();
    const oppSeq = 900_000 + Math.floor(Math.random() * 50_000);
    const oppTitle = `Comment Provenance Opportunity ${suffix}`;
    await pool.query(
      `INSERT INTO "${S}".opportunities (id, workspace_id, title, status, sort_order, seq_prefix, seq_number, created_at, updated_at)
       VALUES ($1, $2, $3, 'EXPLORING', 9000, 'OPP', $4, NOW(), NOW())`,
      [oppId, workspaceId, oppTitle, oppSeq],
    );
    createdOppIds.push(oppId);

    await page.goto(`${base}/discovery/OPP-${oppSeq}`);
    await expect(page.getByRole("heading", { name: oppTitle })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("No comments yet.")).toBeVisible({ timeout: 15_000 });

    const editor = page.getByRole("textbox", { name: "Add comment", exact: true });
    await editor.click();
    await page.keyboard.type(`Expand solution space for discussion integration @${memberName.slice(0, 14)}`);
    await page.getByTestId("mention-option").filter({ hasText: memberName }).first().click();
    await expect(editor.getByTestId("mention-chip")).toContainText(memberName);
    await page.getByRole("button", { name: "Comment & create task" }).click();

    const card = page.getByTestId("comment-task-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    const taskHref = await card.getByTestId("open-task-link").getAttribute("href");
    expect(taskHref).toMatch(/\/tasks\/[0-9a-f-]{36}$/);
    const taskId = taskHref!.split("/tasks/")[1]!;
    createdTaskIds.push(taskId);

    // Resolve the thread on the Opportunity so we verify deep-linking expands resolved Discussion threads too.
    await page.getByRole("button", { name: /Resolve thread by / }).click();
    await expect(page.getByRole("button", { name: /Expand resolved thread by / })).toBeVisible({ timeout: 10_000 });

    // Open the Task full page and inspect the Links / Created from provenance block.
    await page.goto(`${base}/tasks/${taskId}`);
    const originBlock = page.getByTestId("task-origin-links");
    await expect(originBlock).toBeVisible({ timeout: 15_000 });
    await expect(originBlock).toContainText("Created from");

    const expectedPrefix = `Comment on OPP-${oppSeq}: "Expand solution space for discussion integration`;
    const commentLink = originBlock.getByRole("link").filter({ hasText: expectedPrefix });
    await expect(commentLink).toBeVisible();
    await expect(commentLink).toHaveAttribute("href", new RegExp(`/discovery/OPP-${oppSeq}\\?comment=[0-9a-f-]{36}$`));

    // Origin provenance link has NO 'x' unlink button, whereas the Opportunity reference link keeps its Unlink button.
    await expect(originBlock.getByRole("button", { name: /Unlink/i })).toHaveCount(0);
    await expect(page.getByLabel(`Unlink ${oppTitle}`)).toBeVisible();

    // Clicking the COMMENT origin link navigates to OPP-<seq>?comment=<id>, expands the resolved thread, and highlights the comment.
    await commentLink.click();
    await expect(page).toHaveURL(new RegExp(`/discovery/OPP-${oppSeq}\\?comment=[0-9a-f-]{36}$`), { timeout: 15_000 });
    const focusedArticle = page.locator('article[data-comment-focused="true"]');
    await expect(focusedArticle).toBeVisible({ timeout: 15_000 });
    await expect(focusedArticle).toContainText("Expand solution space for discussion integration");
  });

  test("Doc comment -> Done Task: clicking COMMENT origin link opens Comments sidebar, reveals resolved thread, and highlights comment", async ({ page, base }) => {
    test.setTimeout(120_000);
    const docId = randomUUID();
    const docSeq = 900_000 + Math.floor(Math.random() * 50_000);
    const docTitle = `Doc Provenance Spec ${suffix}`;
    await pool.query(
      `INSERT INTO "${S}".docs (id, workspace_id, title, content, sort_order, doc_type, seq_prefix, seq_number, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 9001, 'STANDARD', 'DOC', $5, NOW(), NOW())`,
      [docId, workspaceId, docTitle, "ROLLBACK criteria must be verified before release", docSeq],
    );
    createdDocIds.push(docId);

    await page.goto(`${base}/docs/DOC-${docSeq}`);
    const editor = page.locator(".ProseMirror");
    await expect(editor).toContainText("ROLLBACK", { timeout: 30_000 });
    await editor.click();
    await selectLeadingWord(page, "ROLLBACK");

    await page.getByTitle("Comment on selection").click();
    const commentInput = page.getByRole("textbox", { name: "Comment", exact: true });
    await expect(commentInput).toBeVisible({ timeout: 10_000 });
    await commentInput.click();
    await page.keyboard.type(`Verify rollback steps @${memberName.slice(0, 14)}`);
    await page.getByTestId("mention-option").filter({ hasText: memberName }).first().click();
    await page.getByRole("button", { name: "Comment & create task" }).click();

    const card = page.getByTestId("comment-task-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    const taskHref = await card.getByTestId("open-task-link").getAttribute("href");
    const taskId = taskHref!.split("/tasks/")[1]!;
    createdTaskIds.push(taskId);

    // Mark task DONE so comment-task-sync resolves the Doc comment thread automatically.
    const doneRes = await page.request.patch(`/api/panels/entity/task/${taskId}?orgSlug=${ORG}&workspaceSlug=${WORKSPACE}`, {
      data: { field: "status", value: "DONE" },
    });
    expect(doneRes.ok()).toBe(true);
    await expect.poll(async () => {
      const r = await pool.query<{ status: string }>(`SELECT status FROM "${S}".comments WHERE target_type = 'DOC' AND target_id = $1`, [docId]);
      return r.rows[0]?.status;
    }).toBe("RESOLVED");

    // Open the Task page and verify the anchored Doc comment origin link.
    await page.goto(`${base}/tasks/${taskId}`);
    const originBlock = page.getByTestId("task-origin-links");
    await expect(originBlock).toBeVisible({ timeout: 15_000 });
    const docCommentLink = originBlock.getByRole("link", { name: "Comment on “ROLLBACK”" });
    await expect(docCommentLink).toBeVisible();
    await expect(docCommentLink).toHaveAttribute("href", new RegExp(`/docs/DOC-${docSeq}\\?comment=[0-9a-f-]{36}$`));
    await expect(originBlock.getByRole("button", { name: /Unlink/i })).toHaveCount(0);

    // Click the Doc comment origin link -> opens Doc, opens Comments sidebar, reveals resolved thread, and highlights it.
    await docCommentLink.click();
    await expect(page).toHaveURL(new RegExp(`/docs/DOC-${docSeq}\\?comment=[0-9a-f-]{36}$`), { timeout: 15_000 });
    await expect(page.getByTestId("doc-comments-list")).toBeVisible({ timeout: 15_000 });
    const focusedThread = page.locator('[data-testid="doc-comment-thread"][data-comment-focused="true"]');
    await expect(focusedThread).toBeVisible({ timeout: 15_000 });
    await expect(focusedThread).toContainText("Verify rollback steps");
  });
});
