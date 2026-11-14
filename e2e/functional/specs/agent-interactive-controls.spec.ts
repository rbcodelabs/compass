import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * PR 3 Functional E2E: Interactive Agent Controls (`AskUserQuestion` & `ScheduleWakeup`),
 * `Awaiting` + `Waiting` Board Columns, Inline `QuestionPromptCard`, and Wake-Up Countdown Cancellation.
 */
const S = "compass_dev";

test("Awaiting and Waiting board columns, inline and chat QuestionPromptCard answers, and 1-click ScheduleWakeup cancellation", async ({
  page,
  base,
}) => {
  test.setTimeout(240_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const suffix = randomUUID().slice(0, 8);

  const convWorkingId = randomUUID();
  const convAwaitingBoardId = randomUUID();
  const convAwaitingChatId = randomUUID();
  const convWaitingBoardId = randomUUID();
  const convWaitingChatId = randomUUID();

  const runWorkingId = randomUUID();
  const runAwaitingBoardId = randomUUID();
  const runAwaitingChatId = randomUUID();
  const runWaitingBoardId = randomUUID();
  const runWaitingChatId = randomUUID();

  const questionBoardId = randomUUID();
  const questionChatId = randomUUID();
  const wakeupBoardId = randomUUID();
  const wakeupChatId = randomUUID();

  const allConvIds = [
    convWorkingId,
    convAwaitingBoardId,
    convAwaitingChatId,
    convWaitingBoardId,
    convWaitingChatId,
  ];

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

    // 1. Seed Working conversation
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, summary, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - interval '4 minutes', NOW() - interval '30 seconds')`,
      [
        convWorkingId,
        workspaceId,
        userId,
        `Verify DSQL async index postconditions ${suffix}`,
        "Checking migration 121_agent_interactive_controls column and index readiness.",
      ],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
       VALUES ($1, $2, 'user', 'Run migration postcondition checks', $3, NOW() - interval '3 minutes')`,
      [randomUUID(), convWorkingId, userId],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_runs
         (id, conversation_id, workspace_id, user_id, status, current_activity, worker_token_hash, last_heartbeat_at, deadline_at, status_changed_at)
       VALUES ($1, $2, $3, $4, 'RUNNING', 'Running vitest · agent-interactive-controls-migration.test.ts', $5, NOW(), NOW() + interval '30 minutes', NOW() - interval '30 seconds')`,
      [runWorkingId, convWorkingId, workspaceId, userId, randomUUID().replaceAll("-", "").padEnd(64, "a")],
    );

    // 2. Seed Awaiting #1 (for inline Board answer)
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, summary, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - interval '6 minutes', NOW() - interval '45 seconds')`,
      [
        convAwaitingBoardId,
        workspaceId,
        userId,
        `Rollout strategy for interactive inbox ${suffix}`,
        "Drafted feature flag gates; awaiting rollout tier selection.",
      ],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
       VALUES ($1, $2, 'user', 'Prepare the rollout plan for interactive agent controls.', $3, NOW() - interval '5 minutes'),
              ($4, $2, 'assistant', 'I inspected workspace gates and prepared rollout options. Let me confirm your preferred tier before editing the config.', NULL, NOW() - interval '45 seconds')`,
      [randomUUID(), convAwaitingBoardId, userId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_runs
         (id, conversation_id, workspace_id, user_id, status, substatus, current_activity, worker_token_hash, last_heartbeat_at, deadline_at, status_changed_at)
       VALUES ($1, $2, $3, $4, 'RUNNING', 'AWAITING_QUESTION', 'Waiting for your answer: Rollout Tier', $5, NOW(), NOW() + interval '25 minutes', NOW() - interval '45 seconds')`,
      [runAwaitingBoardId, convAwaitingBoardId, workspaceId, userId, randomUUID().replaceAll("-", "").padEnd(64, "b")],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_inbox_items
         (id, workspace_id, conversation_id, recipient_user_id, source_conversation_id, run_id, native_tool_use_id,
          kind, header, question, options_json, multi_select, allow_other, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $3, $5, 'chat-ask-board', 'QUESTION', 'Rollout Tier',
               'How should we roll out interactive agent controls?', $6, false, true, 'PENDING', NOW() - interval '45 seconds', NOW() - interval '45 seconds')`,
      [
        questionBoardId,
        workspaceId,
        convAwaitingBoardId,
        userId,
        runAwaitingBoardId,
        JSON.stringify([
          { label: "Phased workspace beta", description: "Enable for design partners first, then expand" },
          { label: "General availability", description: "Enable across all active workspaces immediately" },
        ]),
      ],
    );

    // 3. Seed Awaiting #2 (for Chat composer QuestionPromptCard answer)
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, summary, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - interval '8 minutes', NOW() - interval '1 minute')`,
      [
        convAwaitingChatId,
        workspaceId,
        userId,
        `Session resume policy on deadline park ${suffix}`,
        "Checking how parked sandboxes hand off transcript state.",
      ],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
       VALUES ($1, $2, 'user', 'Design the deadline-park fallback when a user answers hours later.', $3, NOW() - interval '7 minutes'),
              ($4, $2, 'assistant', 'When a run approaches deadlineAt - 30s, it reconciles docs and uploads session-out.jsonl.gz before parking. Please confirm how continuation turns should resume.', NULL, NOW() - interval '1 minute')`,
      [randomUUID(), convAwaitingChatId, userId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_runs
         (id, conversation_id, workspace_id, user_id, status, substatus, current_activity, worker_token_hash, last_heartbeat_at, deadline_at, status_changed_at)
       VALUES ($1, $2, $3, $4, 'RUNNING', 'AWAITING_QUESTION', 'Waiting for your answer: Resume Mode', $5, NOW(), NOW() + interval '25 minutes', NOW() - interval '1 minute')`,
      [runAwaitingChatId, convAwaitingChatId, workspaceId, userId, randomUUID().replaceAll("-", "").padEnd(64, "c")],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_inbox_items
         (id, workspace_id, conversation_id, recipient_user_id, source_conversation_id, run_id, native_tool_use_id,
          kind, header, question, options_json, multi_select, allow_other, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $3, $5, 'chat-ask-composer', 'QUESTION', 'Resume Mode',
               'How should deadline-parked conversations resume once answered?', $6, false, true, 'PENDING', NOW() - interval '1 minute', NOW() - interval '1 minute')`,
      [
        questionChatId,
        workspaceId,
        convAwaitingChatId,
        userId,
        runAwaitingChatId,
        JSON.stringify([
          {
            label: "Resume AgentSession + warm sandbox",
            description: "Rehydrate full Claude SDK transcript and reuse conversation sandbox disk when warm",
          },
          {
            label: "Text-only history replay",
            description: "Boot a clean stateless sandbox from message history only",
          },
        ]),
      ],
    );

    // 4. Seed Waiting #1 (Board countdown card)
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, summary, pr_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'https://github.com/rbcodelabs/compass/pull/575', NOW() - interval '12 minutes', NOW() - interval '2 minutes')`,
      [
        convWaitingBoardId,
        workspaceId,
        userId,
        `Monitor CI check-runs on stacked PR ${suffix}`,
        "Pushed feat/agent-interactive-controls and scheduled a 5-minute check on GitHub Actions.",
      ],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
       VALUES ($1, $2, 'user', 'Push the branch and re-check CI in 5 minutes.', $3, NOW() - interval '11 minutes'),
              ($4, $2, 'assistant', 'Branch pushed and CI started. I scheduled a wake-up in 5 minutes to inspect check-runs.', NULL, NOW() - interval '2 minutes')`,
      [randomUUID(), convWaitingBoardId, userId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_runs
         (id, conversation_id, workspace_id, user_id, status, worker_token_hash, deadline_at, status_changed_at)
       VALUES ($1, $2, $3, $4, 'SUCCEEDED', $5, NOW() + interval '10 minutes', NOW() - interval '2 minutes')`,
      [runWaitingBoardId, convWaitingBoardId, workspaceId, userId, randomUUID().replaceAll("-", "").padEnd(64, "d")],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_scheduled_wakeups
         (id, workspace_id, conversation_id, user_id, source_run_id, fire_at, delay_seconds, reason, prompt, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + interval '5 minutes', 300, 'GitHub Actions CI check', 'Inspect PR check-runs and report failures', 'PENDING', NOW() - interval '2 minutes', NOW() - interval '2 minutes')`,
      [wakeupBoardId, workspaceId, convWaitingBoardId, userId, runWaitingBoardId],
    );

    // 5. Seed Waiting #2 (Chat composer countdown + 1-click Cancel)
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, summary, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - interval '15 minutes', NOW() - interval '3 minutes')`,
      [
        convWaitingChatId,
        workspaceId,
        userId,
        `Verify preview deployment readiness ${suffix}`,
        "Waiting 12m for Vercel preview build to finish before running smoke probes.",
      ],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
       VALUES ($1, $2, 'user', 'Check the preview deployment once Vercel finishes building.', $3, NOW() - interval '14 minutes'),
              ($4, $2, 'assistant', 'Preview build is queued. I set a 12-minute wake-up timer to verify /api/health once ready.', NULL, NOW() - interval '3 minutes')`,
      [randomUUID(), convWaitingChatId, userId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_runs
         (id, conversation_id, workspace_id, user_id, status, worker_token_hash, deadline_at, status_changed_at)
       VALUES ($1, $2, $3, $4, 'SUCCEEDED', $5, NOW() + interval '10 minutes', NOW() - interval '3 minutes')`,
      [runWaitingChatId, convWaitingChatId, workspaceId, userId, randomUUID().replaceAll("-", "").padEnd(64, "e")],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_scheduled_wakeups
         (id, workspace_id, conversation_id, user_id, source_run_id, fire_at, delay_seconds, reason, prompt, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + interval '12 minutes', 720, 'Preview deployment health', 'Probe preview /api/health', 'PENDING', NOW() - interval '3 minutes', NOW() - interval '3 minutes')`,
      [wakeupChatId, workspaceId, convWaitingChatId, userId, runWaitingChatId],
    );

    // Open Agent page at 1440x900 desktop viewport
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/agent`);
    await expect(page.getByRole("heading", { name: "Agent", exact: true })).toBeVisible({ timeout: 30_000 });

    // Switch to Board view
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    const board = page.getByTestId("agent-board");
    await expect(board).toBeVisible();

    const workingCol = page.locator('[data-board-column="working"]');
    const awaitingCol = page.locator('[data-board-column="awaiting"]');
    const waitingCol = page.locator('[data-board-column="waiting"]');

    await expect(workingCol.locator(`[data-board-card="${convWorkingId}"]`)).toBeVisible({ timeout: 15_000 });
    await expect(awaitingCol.locator(`[data-board-card="${convAwaitingBoardId}"]`)).toBeVisible();
    await expect(awaitingCol.locator(`[data-board-card="${convAwaitingChatId}"]`)).toBeVisible();
    await expect(waitingCol.locator(`[data-board-card="${convWaitingBoardId}"]`)).toBeVisible();
    await expect(waitingCol.locator(`[data-board-card="${convWaitingChatId}"]`)).toBeVisible();
    expect(await board.locator("a a").count()).toBe(0);

    // Verify Waiting card countdown strip
    const waitingBoardCard = waitingCol.locator(`[data-board-card="${convWaitingBoardId}"]`);
    await expect(waitingBoardCard.getByTestId("board-card-wakeup")).toContainText("GitHub Actions CI check");
    await expect(waitingBoardCard.getByTestId("board-card-wakeup")).toContainText(/Resumes in \d+m/);

    // Screenshot 1: Board with Working, Awaiting (inline QuestionPromptCard), and Waiting (countdown + Cancel)
    await page.screenshot({ path: test.info().outputPath("01-pr3-board-awaiting-waiting.png"), fullPage: false });

    // Answer Awaiting #1 directly inline on the Board card!
    const awaitingBoardCard = awaitingCol.locator(`[data-board-card="${convAwaitingBoardId}"]`);
    const inlinePrompt = awaitingBoardCard.getByTestId("board-card-question-prompt");
    await expect(inlinePrompt).toBeVisible();
    await inlinePrompt.getByRole("button", { name: /Phased workspace beta/i }).click();
    // Clicking inside inline QuestionPromptCard must keep us on the Board
    await expect(board).toBeVisible();
    await inlinePrompt.getByRole("button", { name: "Submit answer" }).click();

    // Card transitions live from Awaiting -> Working!
    await expect(awaitingCol.locator(`[data-board-card="${convAwaitingBoardId}"]`)).toHaveCount(0, { timeout: 15_000 });
    await expect(workingCol.locator(`[data-board-card="${convWorkingId}"]`)).toBeVisible();
    await expect(workingCol.locator(`[data-board-card="${convAwaitingBoardId}"]`)).toBeVisible({ timeout: 15_000 });

    // Screenshot 2: Board after answering inline (card moved from Awaiting -> Working!)
    await page.screenshot({ path: test.info().outputPath("02-pr3-board-after-inline-answer.png"), fullPage: false });

    // Mobile breakpoint check (390x844 iPhone 14): Board renders cleanly without document overflow
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(board).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("05-pr3-mobile-board.png"), fullPage: false });

    // Restore desktop viewport to click into Chat view
    await page.setViewportSize({ width: 1440, height: 900 });

    // Open Awaiting #2 in Chat view to verify full QuestionPromptCard above the composer + sidebar status groups
    await awaitingCol.locator(`[data-board-card="${convAwaitingChatId}"]`).getByRole("link").first().click();
    await page.waitForURL(new RegExp(`c=${convAwaitingChatId}`));

    const chatPrompt = page.getByTestId("chat-question-prompt");
    await expect(chatPrompt).toBeVisible({ timeout: 15_000 });
    await expect(chatPrompt).toContainText("Resume Mode");
    await expect(chatPrompt).toContainText("Rehydrate full Claude SDK transcript");

    // Screenshot 3: Chat composer QuestionPromptCard + sidebar Awaiting/Waiting groups
    await page.screenshot({ path: test.info().outputPath("03-pr3-chat-question-prompt.png"), fullPage: false });

    // Mobile breakpoint check (390x844 iPhone 14): Chat QuestionPromptCard fits cleanly above composer
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(chatPrompt).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("06-pr3-mobile-chat-question.png"), fullPage: false });
    await page.setViewportSize({ width: 1440, height: 900 });

    // Select option and submit in Chat
    await chatPrompt.getByRole("button", { name: /Resume AgentSession \+ warm sandbox/i }).click();
    await chatPrompt.getByRole("button", { name: "Submit answer" }).click();
    await expect(chatPrompt).toHaveCount(0, { timeout: 15_000 });

    // Navigate to Waiting #2 in Chat sidebar and verify wake-up countdown banner + 1-click Cancel
    const sidebar = page.getByRole("complementary", { name: "Chat history" });
    await sidebar.getByRole("link", { name: new RegExp(`Verify preview deployment readiness ${suffix}`) }).click();
    await page.waitForURL(new RegExp(`c=${convWaitingChatId}`));

    const wakeupBanner = page.getByTestId("chat-wakeup-banner");
    await expect(wakeupBanner).toBeVisible({ timeout: 15_000 });
    await expect(wakeupBanner).toContainText("Preview deployment health");
    await expect(wakeupBanner).toContainText(/Resumes in \d+m/);

    // Screenshot 4: Chat composer wake-up countdown banner + Cancel button
    await page.screenshot({ path: test.info().outputPath("04-pr3-chat-wakeup-banner.png"), fullPage: false });

    // Click Cancel on the wake-up banner and verify DB status transitions to CANCELED
    await page.getByTestId("chat-wakeup-cancel").click();
    await expect(wakeupBanner).toHaveCount(0, { timeout: 15_000 });

    const {
      rows: [canceledRow],
    } = await pool.query<{ status: string }>(
      `SELECT status FROM "${S}".agent_scheduled_wakeups WHERE id = $1`,
      [wakeupChatId],
    );
    expect(canceledRow?.status).toBe("CANCELED");
  } finally {
    await pool.query(`DELETE FROM "${S}".agent_inbox_items WHERE conversation_id = ANY($1::uuid[])`, [allConvIds]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_scheduled_wakeups WHERE conversation_id = ANY($1::uuid[])`, [allConvIds]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_conversation_reviews WHERE conversation_id = ANY($1::uuid[])`, [allConvIds]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_runs WHERE conversation_id = ANY($1::uuid[])`, [allConvIds]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = ANY($1::uuid[])`, [allConvIds]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = ANY($1::uuid[])`, [allConvIds]).catch(() => {});
    await pool.end();
  }
});
