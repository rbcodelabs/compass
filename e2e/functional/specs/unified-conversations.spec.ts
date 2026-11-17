import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import pg from "pg";
import { randomUUID } from "node:crypto";

const S = "compass_dev";

test("unified conversations: /conversations Chat|Board hub, object Conversations section, passive human turns, and Right PanelShell collapsible breadcrumbs", async ({
  page,
  base,
}) => {
  test.setTimeout(180_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const suffix = randomUUID().slice(0, 8);
  const oppId = randomUUID();
  const oppTitle = `Unified Conversations Opportunity ${suffix}`;
  const seededConvId = randomUUID();
  const seededConvTitle = `Architecture thread ${suffix}`;
  let workspaceId = "";
  let userId = "";

  try {
    const {
      rows: [ids],
    } = await pool.query<{ workspace_id: string; owner_id: string }>(
      `SELECT w.id AS workspace_id, (SELECT id FROM "${S}".users WHERE email = 'dev@localhost.dev') AS owner_id
         FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id
        WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace'`,
    );
    workspaceId = ids.workspace_id;
    userId = ids.owner_id;

    // Ensure migration 125 columns exist in the e2e schema.
    await pool.query(`ALTER TABLE "${S}".agent_conversations ADD COLUMN IF NOT EXISTS target_type VARCHAR(40)`);
    await pool.query(`ALTER TABLE "${S}".agent_conversations ADD COLUMN IF NOT EXISTS target_id UUID`);
    await pool.query(`ALTER TABLE "${S}".agent_conversations ADD COLUMN IF NOT EXISTS visibility VARCHAR(20)`);
    await pool.query(`ALTER TABLE "${S}".agent_conversations ADD COLUMN IF NOT EXISTS status VARCHAR(20)`);
    await pool.query(`ALTER TABLE "${S}".agent_conversations ADD COLUMN IF NOT EXISTS agent_mode VARCHAR(20)`);
    await pool.query(`ALTER TABLE "${S}".agent_conversations ADD COLUMN IF NOT EXISTS source VARCHAR(20)`);
    await pool.query(`ALTER TABLE "${S}".agent_conversations ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP(3)`);
    await pool.query(`ALTER TABLE "${S}".agent_conversations ADD COLUMN IF NOT EXISTS resolved_by_id UUID`);
    await pool.query(`ALTER TABLE "${S}".agent_messages ADD COLUMN IF NOT EXISTS author_name VARCHAR(255)`);
    await pool.query(`ALTER TABLE "${S}".agent_messages ADD COLUMN IF NOT EXISTS author_type VARCHAR(20)`);
    await pool.query(`ALTER TABLE "${S}".agent_messages ADD COLUMN IF NOT EXISTS message_kind VARCHAR(30)`);
    await pool.query(`ALTER TABLE "${S}".agent_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP(3)`);

    // Seed an Opportunity and an anchored shared conversation.
    await pool.query(
      `INSERT INTO "${S}".opportunities (id, workspace_id, title, description, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'Validate unified conversations model.', 'EXPLORING', NOW(), NOW())`,
      [oppId, workspaceId, oppTitle],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, summary, target_type, target_id, visibility, status, agent_mode, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Initial team note on unified schema', 'OPPORTUNITY', $5, 'WORKSPACE', 'OPEN', 'MENTION_ONLY', 'BROWSER', NOW() - interval '5 minutes', NOW() - interval '5 minutes')`,
      [seededConvId, workspaceId, userId, seededConvTitle, oppId],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, author_name, author_type, message_kind, created_at)
       VALUES (gen_random_uuid(), $1, 'user', 'Initial team note on unified schema', $2, 'Dev User', 'HUMAN', 'COMMENT', NOW() - interval '5 minutes')`,
      [seededConvId, userId],
    );

    // 1. Visit /conversations and verify Chat | Board view switcher and Kanban board.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/conversations`);
    await expect(page.getByRole("heading", { name: "Conversations", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const chatTab = page.getByRole("tab", { name: "Chat", exact: true });
    const boardTab = page.getByRole("tab", { name: "Board", exact: true });
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(seededConvTitle).first()).toBeVisible();

    await boardTab.click();
    await expect(page.getByTestId("agent-board")).toBeVisible();
    await expect(page.locator(`[data-board-card="${seededConvId}"]`)).toBeVisible({ timeout: 15_000 });

    // 2. Open the Opportunity in the Right PanelShell on /discovery and inspect its Conversations section.
    await page.goto(`${base}/discovery?detail=opportunity:${oppId}`);
    const objectConvSection = page.getByTestId("object-conversations-section");
    await expect(objectConvSection).toBeVisible({ timeout: 30_000 });
    await expect(objectConvSection).toContainText(seededConvTitle);

    // 3. Click the conversation card in the object's Conversations section to open it in the Right PanelShell
    //    and verify the single-line breadcrumb history bar appears.
    await objectConvSection.getByText(seededConvTitle).click();
    await expect(page).toHaveURL(new RegExp(`detail=conversation%3A${seededConvId}|detail=conversation:${seededConvId}`));
    const breadcrumbNav = page.getByRole("navigation", { name: "Panel history" });
    await expect(breadcrumbNav).toBeVisible();
    await expect(breadcrumbNav).toContainText(seededConvTitle);

    // 4. Verify the @Compass Agent quick-mention pill is shown in MENTION_ONLY mode, and post a passive human turn.
    await expect(page.getByTestId("agent-quick-mention-pill")).toBeVisible();
    const passiveReply = `Passive human follow-up ${suffix}`;
    const composer = page.getByPlaceholder(/message the agent/i);
    await composer.fill(passiveReply);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(passiveReply)).toBeVisible({ timeout: 15_000 });

    // Confirm no AgentRun was created for the passive human turn.
    const { rows: runRows } = await pool.query(
      `SELECT id FROM "${S}".agent_runs WHERE conversation_id = $1`,
      [seededConvId],
    );
    expect(runRows).toHaveLength(0);
  } finally {
    await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = $1`, [seededConvId]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = $1`, [seededConvId]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".opportunities WHERE id = $1`, [oppId]).catch(() => {});
    await pool.end();
  }
});
