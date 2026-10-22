/**
 * Discussion comment @mentions that become Tasks (Roadmap Item discussion).
 *
 * The same picker / "Assign as task" row as Doc comments, in the generic
 * Discussion panel. Drives the real UI: open a Roadmap Item, type "@" in the
 * comment editor, pick a workspace member, post with the task row on, then check
 * the chip, the task card, the persisted links and the edit round trip.
 *
 * B is a workspace member (the assignee). The Roadmap Item is created through
 * the UI, as in shared-comments.spec.ts.
 */
import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import type { Page } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";

test.describe("Discussion comment @mention -> task", () => {
  test.describe.configure({ mode: "serial" });

  const suffix = randomUUID().slice(0, 6);
  const bEmail = `disc-mention-b-${suffix}@localhost.dev`;
  const bName = `Quinn Discussion ${suffix}`;

  let pool: pg.Pool;
  let workspaceId = "";
  let bUserId = "";

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(120_000);
    pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
    const baseURL = test.info().project.use.baseURL as string;
    const login = await playwright.request.newContext({ baseURL });
    const csrf = (await (await login.get("/api/auth/csrf")).json()) as { csrfToken: string };
    const signedIn = await login.post("/api/auth/callback/dev-credentials", {
      form: { csrfToken: csrf.csrfToken, email: bEmail, callbackUrl: `${baseURL}/dashboard` },
      maxRedirects: 0,
    });
    expect([200, 302]).toContain(signedIn.status());
    await login.dispose();
    await pool.query(`UPDATE "${S}".users SET name = $1 WHERE email = $2`, [bName, bEmail]);
    bUserId = (await pool.query<{ id: string }>(`SELECT id FROM "${S}".users WHERE email = $1`, [bEmail])).rows[0].id;
    const { rows: [ws] } = await pool.query<{ id: string }>(
      `SELECT w.id FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $1 AND w.slug = $2`,
      [ORG, WORKSPACE],
    );
    workspaceId = ws.id;
    await pool.query(
      `INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, bUserId],
    );
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  async function openRoadmapItem(page: Page, base: string, title: string) {
    await page.goto(`${base}/roadmap`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Add item" }).nth(1).click();
    await page.getByLabel("Title").fill(title);
    await page.getByRole("button", { name: "Add Item", exact: true }).click();
    const card = page.locator('[data-slot="card"]').filter({ hasText: title });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole("button", { name: title }).click();
    const panel = page.locator('[data-slot="sheet-content"]');
    await expect(panel.getByText("No comments yet.")).toBeVisible({ timeout: 10_000 });
    return panel;
  }

  test("mention a member, assign a task, see chip + card, and edit keeps the chip", async ({ page, base }) => {
    const title = `E2E Discussion Mention ${suffix}`;
    const panel = await openRoadmapItem(page, base, title);

    const editor = panel.getByRole("textbox", { name: "Add comment", exact: true });
    await editor.click();
    await page.keyboard.type("Can you pick this up? @Quinn Disc");
    await panel.getByTestId("mention-option").filter({ hasText: bName }).first().click();
    await expect(editor.getByTestId("mention-chip")).toContainText(bName);

    await expect(panel.getByTestId("comment-task-box")).toContainText(`Assign as task to @${bName}`);
    await panel.getByRole("button", { name: "Comment & create task" }).click();

    const comment = panel.getByRole("article").filter({ hasText: "Can you pick this up?" });
    await expect(comment.getByTestId("comment-mention")).toContainText(`@${bName}`, { timeout: 10_000 });
    await expect(comment.getByTestId("comment-task-card")).toBeVisible();

    // The task is assigned to B and linked to the comment and to the Roadmap Item.
    const { rows } = await pool.query<{ linked_type: string }>(
      `SELECT l.linked_type FROM "${S}".tasks t JOIN "${S}".task_links l ON l.task_id = t.id
        WHERE t.workspace_id = $1 AND t.assignee_user_id = $2 ORDER BY l.linked_type`,
      [workspaceId, bUserId],
    );
    expect(rows.map((row) => row.linked_type)).toEqual(["COMMENT", "ROADMAP_ITEM"]);

    // Reload: chip and card come back from the server.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.locator('[data-slot="card"]').filter({ hasText: title }).getByRole("button", { name: title }).click();
    const reopened = page.locator('[data-slot="sheet-content"]').getByRole("article").filter({ hasText: "Can you pick this up?" });
    await expect(reopened.getByTestId("comment-mention")).toContainText(`@${bName}`, { timeout: 10_000 });
    await expect(reopened.getByTestId("comment-task-card")).toBeVisible();

    // Edit loads the mention back as a chip and saves it as a token.
    await reopened.getByRole("button", { name: /Edit comment by / }).click();
    const edit = page.locator('[data-slot="sheet-content"]').getByRole("textbox", { name: /Edit comment by / });
    await expect(edit.getByTestId("mention-chip")).toContainText(bName);
    await edit.press("End");
    await page.keyboard.type(" Thanks!");
    await page.locator('[data-slot="sheet-content"]').getByRole("button", { name: "Save edit" }).click();
    await expect(reopened.getByText("Thanks!")).toBeVisible({ timeout: 10_000 });
    await expect(reopened.getByTestId("comment-mention")).toContainText(`@${bName}`);
  });
});
