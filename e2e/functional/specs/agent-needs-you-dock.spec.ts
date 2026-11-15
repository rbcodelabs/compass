import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * Milestone 2 (Phases 4–6 / PRs 4–6) Functional E2E:
 *   - `Needs you` board column & `Only needs you` filter toggle
 *   - Inline `ProposedReplyCard` (Edit + Approve & Send), `DecisionCard` (routed to orchestrator),
 *     `ManagerNotesDisclosure`, and `Orchestrator` card badge
 *   - Floating `OrchestratorDock` (`Cmd+J`, animated working ring, Attention Tray, suggestion chips,
 *     and `[[thread:<id>|Title]]` hover-highlight + click navigation)
 *   - Personal `Agent orchestrators` settings panel in Workspace Settings
 */
const S = "compass_dev";

test("Needs you column, ProposedReply & Decision inline inbox cards, OrchestratorDock thread-link highlight, and Agent orchestrators settings", async ({
  page,
  base,
}) => {
  test.setTimeout(240_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const suffix = randomUUID().slice(0, 8);

  const convOrchId = randomUUID();
  const convReplyId = randomUUID();
  const convDecisionId = randomUUID();
  const convWorkingId = randomUUID();

  const orchRowId = randomUUID();
  const supervisionReplyId = randomUUID();
  const supervisionDecisionId = randomUUID();
  const decisionItemId = randomUUID();

  const runOrchId = randomUUID();
  const runReplyId = randomUUID();
  const runDecisionId = randomUUID();
  const runWorkingId = randomUUID();

  const allConvIds = [convOrchId, convReplyId, convDecisionId, convWorkingId];

  try {
    const {
      rows: [ids],
    } = await pool.query<{ workspace_id: string; owner_id: string }>(
      `SELECT w.id AS workspace_id,
              (SELECT id FROM "${S}".users WHERE email = 'dev@localhost.dev') AS owner_id
         FROM "${S}".workspaces w
         JOIN "${S}".organizations o ON o.id = w.organization_id
        WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace'`,
    );
    const workspaceId = ids.workspace_id;
    const userId = ids.owner_id;

    // 1. Seed Workspace Orchestrator conversation + AgentOrchestrator row
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, summary, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - interval '10 minutes', NOW() - interval '20 seconds')`,
      [
        convOrchId,
        workspaceId,
        userId,
        `Workspace Orchestrator ${suffix}`,
        "Supervising 3 active threads; staged 1 proposed reply and 1 schema cutover decision.",
      ],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
       VALUES ($1, $2, 'user', 'What needs me across the workspace right now?', $3, NOW() - interval '4 minutes'),
              ($4, $2, 'assistant', $5, NULL, NOW() - interval '20 seconds')`,
      [
        randomUUID(),
        convOrchId,
        userId,
        randomUUID(),
        `Here are the 2 threads awaiting your input:\n\n1. [[thread:${convReplyId}|Staging rollout check ${suffix}]] — staged a proposed reply to trigger smoke probes.\n2. [[thread:${convDecisionId}|Database index cutover ${suffix}]] — needs your decision on async index timing.`,
      ],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_runs
         (id, conversation_id, workspace_id, user_id, status, worker_token_hash, deadline_at, status_changed_at)
       VALUES ($1, $2, $3, $4, 'SUCCEEDED', $5, NOW() + interval '10 minutes', NOW() - interval '20 seconds')`,
      [runOrchId, convOrchId, workspaceId, userId, randomUUID().replaceAll("-", "").padEnd(64, "1")],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_orchestrators
         (id, workspace_id, user_id, scope_type, scope_key, conversation_id, enabled, wake_on_activity, heartbeat_enabled, heartbeat_minutes, escalations_enabled, created_at, updated_at)
       VALUES ($1, $2, $3, 'WORKSPACE', 'workspace', $4, true, true, true, 30, true, NOW() - interval '10 minutes', NOW() - interval '20 seconds')
       ON CONFLICT (user_id, workspace_id, scope_type, scope_key)
       DO UPDATE SET conversation_id = EXCLUDED.conversation_id, enabled = true, heartbeat_minutes = 30, updated_at = NOW()`,
      [orchRowId, workspaceId, userId, convOrchId],
    );

    // 2. Seed Needs you #1: ProposedReply + ManagerNotes v2
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, summary, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - interval '8 minutes', NOW() - interval '40 seconds')`,
      [
        convReplyId,
        workspaceId,
        userId,
        `Staging rollout check ${suffix}`,
        "Preview deployment passed health checks; ready for smoke probe confirmation.",
      ],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
       VALUES ($1, $2, 'user', 'Deploy the branch to staging and report health.', $3, NOW() - interval '7 minutes'),
              ($4, $2, 'assistant', 'Staging deployment is live and /api/health returned 200 OK.', NULL, NOW() - interval '40 seconds')`,
      [randomUUID(), convReplyId, userId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_runs
         (id, conversation_id, workspace_id, user_id, status, worker_token_hash, deadline_at, status_changed_at)
       VALUES ($1, $2, $3, $4, 'SUCCEEDED', $5, NOW() + interval '10 minutes', NOW() - interval '40 seconds')`,
      [runReplyId, convReplyId, workspaceId, userId, randomUUID().replaceAll("-", "").padEnd(64, "2")],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_conversation_supervision
         (id, workspace_id, conversation_id, supervisor_user_id, manager_notes, manager_notes_updated_at, manager_source_orchestrator_id,
          proposed_reply_text, proposed_reply_generated_at, proposed_reply_author_orchestrator_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - interval '35 seconds', $6, $7, NOW() - interval '30 seconds', $6, NOW() - interval '35 seconds', NOW() - interval '30 seconds')`,
      [
        supervisionReplyId,
        workspaceId,
        convReplyId,
        userId,
        "v2 | state=awaiting_user | cursor=2026-11-15T04:50:00.000Z | verified=yes\nGoal: Verify staging deploy.\nCompleted: /api/health verified 200 OK.\nNext: Run Playwright smoke suite.",
        orchRowId,
        "Run the Playwright smoke suite against staging and post the report.",
      ],
    );

    // 3. Seed Needs you #2: Orchestrator DecisionCard
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, summary, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - interval '9 minutes', NOW() - interval '50 seconds')`,
      [
        convDecisionId,
        workspaceId,
        userId,
        `Database index cutover ${suffix}`,
        "Prepared migration 123 async index DDL; awaiting cutover window decision.",
      ],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
       VALUES ($1, $2, 'user', 'Prepare the DSQL index cutover plan.', $3, NOW() - interval '8 minutes'),
              ($4, $2, 'assistant', 'Prepared CREATE INDEX ASYNC IF NOT EXISTS statements for agent_orchestrator_wakeups.', NULL, NOW() - interval '50 seconds')`,
      [randomUUID(), convDecisionId, userId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_runs
         (id, conversation_id, workspace_id, user_id, status, worker_token_hash, deadline_at, status_changed_at)
       VALUES ($1, $2, $3, $4, 'SUCCEEDED', $5, NOW() + interval '10 minutes', NOW() - interval '50 seconds')`,
      [runDecisionId, convDecisionId, workspaceId, userId, randomUUID().replaceAll("-", "").padEnd(64, "3")],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_conversation_supervision
         (id, workspace_id, conversation_id, supervisor_user_id, manager_notes, manager_notes_updated_at, manager_source_orchestrator_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - interval '45 seconds', $6, NOW() - interval '45 seconds', NOW() - interval '45 seconds')`,
      [
        supervisionDecisionId,
        workspaceId,
        convDecisionId,
        userId,
        "v2 | state=awaiting_user | cursor=2026-11-15T04:49:00.000Z | verified=no\nBlocked on user decision for index cutover window.",
        orchRowId,
      ],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_inbox_items
         (id, workspace_id, conversation_id, recipient_user_id, source_conversation_id,
          kind, header, question, options_json, multi_select, allow_other, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'DECISION', 'Index Cutover',
               'When should we apply the async index migration in production?', $6, false, true, 'PENDING', NOW() - interval '45 seconds', NOW() - interval '45 seconds')`,
      [
        decisionItemId,
        workspaceId,
        convDecisionId,
        userId,
        convOrchId,
        JSON.stringify([
          { label: "Apply immediately via /api/admin/migrate", description: "Zero-downtime async index build" },
          { label: "Hold until off-peak maintenance window", description: "Run during scheduled maintenance" },
        ]),
      ],
    );

    // 4. Seed Working conversation (drives OrchestratorDock animated ring)
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, summary, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - interval '5 minutes', NOW() - interval '15 seconds')`,
      [
        convWorkingId,
        workspaceId,
        userId,
        `Run parity & scope guard suites ${suffix}`,
        "Executing vitest on orchestrator scope and wakeup state machine.",
      ],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
       VALUES ($1, $2, 'user', 'Run the orchestrator unit suites.', $3, NOW() - interval '4 minutes')`,
      [randomUUID(), convWorkingId, userId],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_runs
         (id, conversation_id, workspace_id, user_id, status, current_activity, worker_token_hash, last_heartbeat_at, deadline_at, status_changed_at)
       VALUES ($1, $2, $3, $4, 'RUNNING', 'Running vitest · lib/orchestrator/wakeups.test.ts', $5, NOW(), NOW() + interval '25 minutes', NOW() - interval '15 seconds')`,
      [runWorkingId, convWorkingId, workspaceId, userId, randomUUID().replaceAll("-", "").padEnd(64, "4")],
    );

    // Open Agent page at 1280x800 desktop viewport
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/agent`);
    await expect(page.getByRole("heading", { name: "Agent", exact: true })).toBeVisible({ timeout: 30_000 });

    // Switch to Board view
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    const board = page.getByTestId("agent-board");
    await expect(board).toBeVisible();

    const needsYouCol = page.locator('[data-board-column="needs_you"]');
    const workingCol = page.locator('[data-board-column="working"]');
    const newCol = page.locator('[data-board-column="new"]');

    await expect(needsYouCol.locator(`[data-board-card="${convReplyId}"]`)).toBeVisible({ timeout: 15_000 });
    await expect(needsYouCol.locator(`[data-board-card="${convDecisionId}"]`)).toBeVisible();
    await expect(workingCol.locator(`[data-board-card="${convWorkingId}"]`)).toBeVisible();
    await expect(newCol.locator(`[data-board-card="${convOrchId}"]`)).toBeVisible();

    // Verify Orchestrator badge on the Workspace Orchestrator card
    const orchCard = newCol.locator(`[data-board-card="${convOrchId}"]`);
    await expect(orchCard.getByTestId("board-card-orchestrator-badge")).toHaveText("Orchestrator");

    // Expand Manager Notes v2 disclosure on convReplyId
    const replyCard = needsYouCol.locator(`[data-board-card="${convReplyId}"]`);
    await replyCard.getByTestId("manager-notes-toggle").click();
    await expect(replyCard.getByTestId("manager-notes-content")).toContainText("v2 | state=awaiting_user");

    // Verify OrchestratorDock pill, animated working ring, and badge dot
    const dockOrb = page.getByTestId("orchestrator-dock-orb");
    await expect(dockOrb).toHaveAttribute("data-working", "true");
    await expect(page.getByTestId("orchestrator-dock-badge")).toBeVisible();

    // Screenshot 1: Desktop Board with Needs you column (ProposedReply + Decision + ManagerNotes) & OrchestratorDock pill
    await page.screenshot({ path: test.info().outputPath("01-pr6-desktop-board-needs-you.png"), fullPage: false });

    // Toggle "Only needs you" filter chip
    const onlyNeedsYouBtn = page.getByTestId("agent-board-only-needs-you");
    await onlyNeedsYouBtn.click();
    await expect(workingCol.locator(`[data-board-card="${convWorkingId}"]`)).toHaveCount(0);
    await expect(needsYouCol.locator(`[data-board-card="${convReplyId}"]`)).toBeVisible();
    await onlyNeedsYouBtn.click();
    await expect(workingCol.locator(`[data-board-card="${convWorkingId}"]`)).toBeVisible();

    // Open OrchestratorDock sheet and verify Attention Tray + [[thread:<id>|Title]] hover highlight
    await dockOrb.click();
    const dockSheet = page.getByTestId("orchestrator-dock-sheet");
    await expect(dockSheet).toBeVisible();
    await expect(dockSheet.getByTestId("orchestrator-dock-attention-tray")).toBeVisible();

    const threadChip = dockSheet
      .locator(`[data-testid="thread-link-chip"][data-thread-link="${convReplyId}"]`)
      .first();
    await expect(threadChip).toBeVisible({ timeout: 15_000 });
    await threadChip.hover();
    await expect(replyCard).toHaveAttribute("data-highlighted", "true");

    // Screenshot 2: Desktop Board with OrchestratorDock sheet open + [[thread:...]] hover highlight active
    await page.screenshot({ path: test.info().outputPath("02-pr6-desktop-orchestrator-dock-sheet.png"), fullPage: false });

    // Close dock sheet to interact with inline cards
    await dockSheet.getByTestId("orchestrator-dock-close").click();
    await expect(dockSheet).toHaveCount(0);

    // Edit & Approve ProposedReplyCard inline on the Board
    const proposedReplyBox = replyCard.getByTestId("board-card-proposed-reply");
    await proposedReplyBox.getByTestId("proposed-reply-edit").click();
    const replyTextarea = proposedReplyBox.getByTestId("proposed-reply-textarea");
    await replyTextarea.fill("Run Playwright smoke suite against staging and verify zero console errors.");
    await proposedReplyBox.getByTestId("proposed-reply-approve").click();
    await expect(needsYouCol.locator(`[data-board-card="${convReplyId}"]`)).toHaveCount(0, { timeout: 15_000 });

    // Submit DecisionCard inline on the Board and verify answer is posted to convOrchId
    const decisionCard = needsYouCol.locator(`[data-board-card="${convDecisionId}"]`);
    const decisionPrompt = decisionCard.getByTestId("board-card-decision-prompt");
    await decisionPrompt.getByRole("button", { name: /Apply immediately via \/api\/admin\/migrate/i }).click();
    await decisionPrompt.getByTestId("decision-card-submit").click();
    await expect(needsYouCol.locator(`[data-board-card="${convDecisionId}"]`)).toHaveCount(0, { timeout: 15_000 });

    // Verify in DB that the decision answer was posted as a user turn on convOrchId (the orchestrator thread!)
    const { rows: orchMsgs } = await pool.query<{ content: string }>(
      `SELECT content FROM "${S}".agent_messages WHERE conversation_id = $1 AND role = 'user' ORDER BY created_at DESC LIMIT 1`,
      [convOrchId],
    );
    expect(orchMsgs[0]?.content).toContain(`Decision Index Cutover [${decisionItemId}]: Apply immediately via /api/admin/migrate`);

    // Mobile viewport check (390x844) on Board + OrchestratorDock
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(board).toBeVisible();
    await page.getByTestId("orchestrator-dock-orb").click();
    await expect(page.getByTestId("orchestrator-dock-sheet")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("03-pr6-mobile-board-dock.png"), fullPage: false });

    // Verify Workspace Settings -> Agent orchestrators panel on Desktop (1280x800) and Mobile (390x844)
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/settings`);
    const orchSettingsPanel = page.getByTestId("agent-orchestrators-panel");
    await orchSettingsPanel.scrollIntoViewIfNeeded();
    await expect(orchSettingsPanel).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: test.info().outputPath("04-pr5-desktop-settings-orchestrators.png"), fullPage: false });

    await page.setViewportSize({ width: 390, height: 844 });
    await orchSettingsPanel.scrollIntoViewIfNeeded();
    await expect(orchSettingsPanel).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("05-pr5-mobile-settings-orchestrators.png"), fullPage: false });
  } finally {
    await pool
      .query(`DELETE FROM "${S}".agent_orchestrator_wakeups WHERE target_conversation_id = ANY($1::uuid[])`, [allConvIds])
      .catch(() => {});
    await pool
      .query(`DELETE FROM "${S}".agent_conversation_supervision WHERE conversation_id = ANY($1::uuid[])`, [allConvIds])
      .catch(() => {});
    await pool
      .query(`DELETE FROM "${S}".agent_inbox_items WHERE conversation_id = ANY($1::uuid[])`, [allConvIds])
      .catch(() => {});
    await pool
      .query(`DELETE FROM "${S}".agent_orchestrators WHERE id = $1`, [orchRowId])
      .catch(() => {});
    await pool
      .query(`DELETE FROM "${S}".agent_runs WHERE conversation_id = ANY($1::uuid[])`, [allConvIds])
      .catch(() => {});
    await pool
      .query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = ANY($1::uuid[])`, [allConvIds])
      .catch(() => {});
    await pool
      .query(`DELETE FROM "${S}".agent_conversations WHERE id = ANY($1::uuid[])`, [allConvIds])
      .catch(() => {});
    await pool.end();
  }
});
