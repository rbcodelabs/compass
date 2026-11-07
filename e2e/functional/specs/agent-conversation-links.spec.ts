import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import pg from "pg";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * RM-19: agent conversations are linked to the Opportunities, Solutions and Tasks they touch.
 *
 * No LLM turn is needed. The links are written by the MCP tool dispatcher (unit-tested in __tests__/links/conversation-links.test.ts);
 * this spec seeds the links the dispatcher would have written and drives what a person sees:
 *   - the chat's "Linked objects" card (titles + links to the objects),
 *   - the "Conversations" section on an opportunity and a task, limited to conversations the viewer may open,
 *   - removing an automatic link, and the 404 for a conversation the viewer cannot open,
 * at desktop and mobile widths (screenshots land in test-results/agent-conversation-links/).
 */
const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";
const SHOTS = path.join(process.cwd(), "test-results", "agent-conversation-links");

test("the chat lists linked objects; opportunities and tasks list only the conversations the viewer may open; auto links are removable", async ({ page, base }) => {
  test.setTimeout(240_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const suffix = randomUUID().slice(0, 8);
  const visibleTitle = `Planning chat ${suffix}`;
  const privateTitle = `Private chat ${suffix}`;
  const oppTitle = `Linked opportunity ${suffix}`;
  const taskTitle = `Linked task ${suffix}`;
  const visibleId = randomUUID();
  const privateId = randomUUID();
  const oppId = randomUUID();
  const taskId = randomUUID();
  const bEmail = `conv-links-b-${suffix}@localhost.dev`;

  try {
    // A second workspace member who owns a conversation the dev user cannot open.
    const login = await page.context().browser()!.newContext();
    const csrf = (await (await login.request.get(`${test.info().project.use.baseURL}/api/auth/csrf`)).json()) as { csrfToken: string };
    await login.request.post(`${test.info().project.use.baseURL}/api/auth/callback/dev-credentials`, {
      form: { csrfToken: csrf.csrfToken, email: bEmail, callbackUrl: `${test.info().project.use.baseURL}/dashboard` },
      maxRedirects: 0,
    });
    await login.close();
    const { rows: [b] } = await pool.query<{ id: string }>(`SELECT id FROM "${S}".users WHERE email = $1`, [bEmail]);
    const { rows: [ids] } = await pool.query<{ workspace_id: string; owner_id: string }>(
      `SELECT w.id AS workspace_id, (SELECT id FROM "${S}".users WHERE email = 'dev@localhost.dev') AS owner_id
         FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $1 AND w.slug = $2`,
      [ORG, WORKSPACE],
    );
    const workspaceId = ids.workspace_id;
    await pool.query(
      `INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, b.id],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW()), ($5, $2, $6, $7, NOW(), NOW())`,
      [visibleId, workspaceId, ids.owner_id, visibleTitle, privateId, b.id, privateTitle],
    );
    await pool.query(`INSERT INTO "${S}".opportunities (id, workspace_id, title) VALUES ($1, $2, $3)`, [oppId, workspaceId, oppTitle]);
    await pool.query(`INSERT INTO "${S}".tasks (id, workspace_id, title) VALUES ($1, $2, $3)`, [taskId, workspaceId, taskTitle]);
    const link = (type: string, conversation: string, toType: string, to: string) =>
      pool.query(
        `INSERT INTO "${S}".entity_links (workspace_id, link_type, from_type, from_id, to_type, to_id, origin, source, created_at, updated_at)
         VALUES ($1, $2, 'AGENT_CONVERSATION', $3, $4, $5, 'DIRECT', 'AGENT', NOW(), NOW())`,
        [workspaceId, type, conversation, toType, to],
      );
    await link("CONVERSATION_CREATED", visibleId, "OPPORTUNITY", oppId);
    await link("CONVERSATION_MENTIONS", visibleId, "TASK", taskId);
    await link("CONVERSATION_MENTIONS", privateId, "OPPORTUNITY", oppId);
    await link("CONVERSATION_CREATED", privateId, "TASK", taskId);

    // ── Chat: the Linked objects card lists both objects with titles and links
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/agent?c=${visibleId}`);
    const card = page.getByRole("region", { name: "Linked objects" });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole("link", { name: oppTitle })).toHaveAttribute("href", new RegExp(`${base}/discovery/`));
    await expect(card.getByRole("link", { name: taskTitle })).toHaveAttribute("href", new RegExp(`${base}/tasks/`));
    await expect(card.getByTestId("linked-object")).toHaveCount(2);
    await page.screenshot({ path: path.join(SHOTS, "chat-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "chat-mobile.png") });

    // The private conversation is a 404 for this viewer, on the API and in the UI.
    expect((await page.request.get(`/api/agent/conversations/${privateId}/links?workspaceId=${workspaceId}`)).status()).toBe(404);
    expect((await page.request.get(`/api/agent/conversations/${visibleId}/links?workspaceId=${workspaceId}`)).status()).toBe(200);

    // ── Opportunity: only the conversation this viewer may open, with its relationship; the private one never appears
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/discovery/${oppId}`);
    const conversations = page.getByTestId("linked-conversations");
    await expect(conversations).toBeVisible({ timeout: 30_000 });
    await expect(conversations.getByTestId("linked-conversation")).toHaveCount(1);
    await expect(conversations.getByRole("link", { name: visibleTitle })).toHaveAttribute("href", `${base}/agent?c=${visibleId}`);
    await expect(conversations.getByText("Created here")).toBeVisible();
    await expect(page.getByText(privateTitle), "an inaccessible conversation's title never reaches the page").toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, "opportunity-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(conversations).toBeVisible();
    await conversations.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "opportunity-mobile.png") });

    // ── Task: the same, as "Mentioned"
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/tasks/${taskId}`);
    const taskConversations = page.getByTestId("linked-conversations");
    await expect(taskConversations.getByRole("link", { name: visibleTitle })).toBeVisible({ timeout: 30_000 });
    await expect(taskConversations.getByText("Mentioned")).toBeVisible();
    await expect(page.getByText(privateTitle)).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, "task-desktop.png") });

    // ── Removing an automatic link: gone from the page and from the table; the private conversation's link is untouched
    await page.goto(`${base}/discovery/${oppId}`);
    await page.getByRole("button", { name: `Remove link to conversation ${visibleTitle}` }).click();
    await expect(page.getByTestId("linked-conversations")).toHaveCount(0, { timeout: 15_000 });
    const left = await pool.query<{ from_id: string }>(`SELECT from_id FROM "${S}".entity_links WHERE to_id = $1 AND link_type LIKE 'CONVERSATION_%'`, [oppId]);
    expect(left.rows.map((r) => r.from_id)).toEqual([privateId]);
  } finally {
    await pool.query(`DELETE FROM "${S}".entity_links WHERE from_id = ANY($1::uuid[])`, [[visibleId, privateId]]);
    await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = ANY($1::uuid[])`, [[visibleId, privateId]]);
    await pool.query(`DELETE FROM "${S}".opportunities WHERE id = $1`, [oppId]);
    await pool.query(`DELETE FROM "${S}".tasks WHERE id = $1`, [taskId]);
    await pool.end();
  }
});
