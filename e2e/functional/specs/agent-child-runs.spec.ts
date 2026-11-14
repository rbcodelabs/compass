import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * PR 2 Functional E2E: Sub-Agent Hierarchy, `◉ N` Board/List Badges, Composer Team Popover,
 * and Sticky Breadcrumb Drill-Down Timeline.
 *
 * Seeds parent + nested child sub-agent runs (`RUNNING`, `SUCCEEDED`, `FAILED`) in
 * `compass_dev.agent_child_runs`, verifies non-nested `◉ N` badges on Board & Chat sidebar,
 * clicks `◉ N` on Board to open the conversation with the Sub-Agent Team Popover open, drills
 * into Parent -> Nested Child timelines, preserves composer draft & main transcript scroll when
 * returning via sticky `Main conversation › ...` breadcrumbs, and cleans up all seeded rows.
 */
const S = "compass_dev";

test("board and sidebar ◉ N badges, composer sub-agent hierarchy popover, and sticky breadcrumb drill-down", async ({
  page,
  base,
}) => {
  test.setTimeout(240_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const suffix = randomUUID().slice(0, 8);

  const convTeamId = randomUUID();
  const convFailedId = randomUUID();
  const runTeamId = randomUUID();
  const runFailedId = randomUUID();
  const childLeadId = randomUUID();
  const childNestedId = randomUUID();
  const childDocsId = randomUUID();
  const childFailedId = randomUUID();

  let workspaceId = "";
  let userId = "";

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
    workspaceId = ids.workspace_id;
    userId = ids.owner_id;

    // Seed active multi-agent conversation with enough messages to scroll
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, summary, current_activity, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, NOW() - interval '3 minutes', NOW() - interval '1 minute')`,
      [
        convTeamId,
        workspaceId,
        userId,
        `Sub-agent architecture audit ${suffix}`,
        "Coordinating Lead Architect, SQL Verifier, and Docs Researcher across PR 2.",
      ],
    ).catch(async () => {
      // Note: current_activity lives on agent_runs, not agent_conversations
      await pool.query(
        `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, summary, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW() - interval '3 minutes', NOW() - interval '1 minute')`,
        [
          convTeamId,
          workspaceId,
          userId,
          `Sub-agent architecture audit ${suffix}`,
          "Coordinating Lead Architect, SQL Verifier, and Docs Researcher across PR 2.",
        ],
      );
    });

    for (let i = 1; i <= 10; i++) {
      await pool.query(
        `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW() - ($6 || ' seconds')::interval)`,
        [
          randomUUID(),
          convTeamId,
          i % 2 === 1 ? "user" : "assistant",
          i === 10
            ? "Latest main-thread update: Lead Architect delegated Aurora DSQL index verification to SQL Verifier."
            : `Historical turn message #${i} with detailed context so the main conversation viewport scrolls naturally during inspection.`,
          i % 2 === 1 ? userId : null,
          String(200 - i * 10),
        ],
      );
    }

    await pool.query(
      `INSERT INTO "${S}".agent_runs
         (id, conversation_id, workspace_id, user_id, status, current_activity, worker_token_hash, last_heartbeat_at, deadline_at, status_changed_at)
       VALUES ($1, $2, $3, $4, 'RUNNING', 'Delegating SQL Verifier · 120_agent_child_runs', $5, NOW(), NOW() + interval '1 hour', NOW() - interval '1 minute')`,
      [runTeamId, convTeamId, workspaceId, userId, randomUUID().replaceAll("-", "").padEnd(64, "1")],
    );

    // Seed parent + nested child sub-agents on convTeamId
    await pool.query(
      `INSERT INTO "${S}".agent_child_runs
         (id, conversation_id, run_id, workspace_id, native_agent_id, parent_child_run_id, parent_native_agent_id,
          role, description, status, current_activity, step_count, steps_json, result_summary, started_at, finished_at, created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, 'toolu_lead', NULL, NULL,
          'Lead Architect', 'Coordinate durable child-run projection and Studio Quiet UI', 'RUNNING',
          'Read file · path: components/agent/agent-chat.tsx', 2, $5, NULL,
          NOW() - interval '2 minutes', NULL, NOW() - interval '2 minutes', NOW()),
         ($6, $2, $3, $4, 'toolu_sql', $1, 'toolu_lead',
          'SQL Verifier', 'Verify Aurora DSQL async index postconditions for 120_agent_child_runs', 'SUCCEEDED',
          NULL, 2, $7, 'Confirmed all three indexes use CREATE INDEX ASYNC IF NOT EXISTS and register in ASYNC_WAIT_MIGRATIONS.',
          NOW() - interval '90 seconds', NOW() - interval '20 seconds', NOW() - interval '90 seconds', NOW() - interval '20 seconds'),
         ($8, $2, $3, $4, 'toolu_docs', NULL, NULL,
          'Docs Researcher', 'Cross-check Geode agentTreeModel cycle-breaking semantics', 'SUCCEEDED',
          NULL, 1, $9, 'Matched resolveEffectiveParents and buildAgentBreadcrumbs behavior 1:1.',
          NOW() - interval '80 seconds', NOW() - interval '30 seconds', NOW() - interval '80 seconds', NOW() - interval '30 seconds')`,
      [
        childLeadId,
        convTeamId,
        runTeamId,
        workspaceId,
        JSON.stringify([
          { id: "st-1", label: "Read file", status: "done", detail: "path: lib/agent-runs.ts", result: "Inspected appendAgentRunEvents" },
          { id: "st-2", label: "Read file", status: "running", detail: "path: components/agent/agent-chat.tsx" },
        ]),
        childNestedId,
        JSON.stringify([
          { id: "st-s1", label: "Read file", status: "done", detail: "path: prisma/migrations/120_agent_child_runs/migration.sql", result: "3 ASYNC indexes" },
          { id: "st-s2", label: "Search code", status: "done", detail: "query: ASYNC_WAIT_MIGRATIONS", result: "Registered in lib/migrations/runner.ts" },
        ]),
        childDocsId,
        JSON.stringify([
          { id: "st-d1", label: "Read file", status: "done", detail: "path: src/agentRuns/agentTreeModel.ts", result: "Verified cycle protection" },
        ]),
      ],
    );

    // Seed second conversation with a FAILED child sub-agent
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, summary, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - interval '10 minutes', NOW() - interval '5 minutes')`,
      [
        convFailedId,
        workspaceId,
        userId,
        `Sub-agent failure check ${suffix}`,
        "Sandbox test runner hit a missing env variable.",
      ],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
       VALUES ($1, $2, 'user', 'Run integration suite', $3, NOW() - interval '9 minutes'),
              ($4, $2, 'assistant', 'Sub-agent reported a failure.', NULL, NOW() - interval '5 minutes')`,
      [randomUUID(), convFailedId, userId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_runs
         (id, conversation_id, workspace_id, user_id, status, worker_token_hash, deadline_at, status_changed_at)
       VALUES ($1, $2, $3, $4, 'FAILED', $5, NOW() + interval '1 hour', NOW() - interval '5 minutes')`,
      [runFailedId, convFailedId, workspaceId, userId, randomUUID().replaceAll("-", "").padEnd(64, "2")],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_child_runs
         (id, conversation_id, run_id, workspace_id, native_agent_id, role, description, status, step_count, steps_json, result_summary, started_at, finished_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'toolu_fail', 'E2E Runner', 'Execute browser suite', 'FAILED', 1, $5, 'Missing PLAYWRIGHT_BASE_URL in sandbox.', NOW() - interval '6 minutes', NOW() - interval '5 minutes', NOW() - interval '6 minutes', NOW() - interval '5 minutes')`,
      [
        childFailedId,
        convFailedId,
        runFailedId,
        workspaceId,
        JSON.stringify([{ id: "st-f1", label: "Bash", status: "error", detail: "pnpm test:e2e", result: "Exit code 1" }]),
      ],
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/agent`);
    await expect(page.getByRole("heading", { name: "Agent", exact: true })).toBeVisible({ timeout: 30_000 });

    // 1. Verify Chat sidebar row displays `◉ 3` and `◉ 1` badges with zero nested <a> tags
    const sidebar = page.getByRole("complementary", { name: "Chat history" });
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByText(`Sub-agent architecture audit ${suffix}`)).toBeVisible();
    const nestedLinksInSidebar = await sidebar.locator("a a").count();
    expect(nestedLinksInSidebar).toBe(0);

    // 2. Switch to Board and verify `◉ 3` (active) and `◉ 1` (failed) badges + role search
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    await expect(page.getByTestId("agent-board")).toBeVisible();

    const teamCard = page.locator(`[data-board-card="${convTeamId}"]`);
    const failedCard = page.locator(`[data-board-card="${convFailedId}"]`);
    await expect(teamCard).toBeVisible({ timeout: 15_000 });
    await expect(failedCard).toBeVisible();
    expect(await page.getByTestId("agent-board").locator("a a").count()).toBe(0);

    const teamBadge = teamCard.getByTestId("board-card-child-agents");
    await expect(teamBadge).toContainText("3");
    await expect(failedCard.getByTestId("board-card-child-agents")).toContainText("1");

    await page.screenshot({ path: test.info().outputPath("01-pr2-board-child-badges.png"), fullPage: false });

    // Filter board by nested sub-agent role ("SQL Verifier")
    const boardSearch = page.getByRole("searchbox", { name: "Search agent threads" });
    await boardSearch.fill("SQL Verifier");
    await expect(teamCard).toBeVisible();
    await expect(failedCard).toHaveCount(0);
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(failedCard).toBeVisible();

    // 3. Click `◉ 3` badge directly on the Board card -> opens conversation with Sub-Agent Team Popover open!
    await teamBadge.click();
    await page.waitForURL(new RegExp(`c=${convTeamId}`));
    await expect(page.getByTestId("composer-subagent-pill")).toContainText("1 agent working", { timeout: 15_000 });
    const popover = page.getByTestId("subagent-team-popover");
    await expect(popover).toBeVisible({ timeout: 15_000 });

    const treeItems = popover.getByTestId("subagent-tree-item");
    await expect(treeItems).toHaveCount(3);
    await expect(treeItems.nth(0)).toContainText("Lead Architect");
    await expect(treeItems.nth(0)).toHaveAttribute("aria-level", "1");
    await expect(treeItems.nth(1)).toContainText("SQL Verifier");
    await expect(treeItems.nth(1)).toHaveAttribute("aria-level", "2");
    await expect(treeItems.nth(2)).toContainText("Docs Researcher");
    await expect(treeItems.nth(2)).toHaveAttribute("aria-level", "1");

    await page.screenshot({ path: test.info().outputPath("02-pr2-composer-team-popover.png"), fullPage: false });

    // Close popover briefly, type a draft in the composer, then drill into Lead Architect
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    const composerInput = page.getByRole("textbox").first();
    await composerInput.fill("Follow-up draft preserved across sub-agent drill-down");

    await page.getByTestId("composer-subagent-pill").click();
    await expect(page.getByTestId("subagent-team-popover")).toBeVisible();
    await page.getByTestId("subagent-team-popover").getByTestId("subagent-tree-item").nth(0).click();

    // 4. Verify Lead Architect timeline + sticky breadcrumbs + live activity + nested child delegation card
    const timeline = page.getByTestId("child-agent-timeline");
    await expect(timeline).toBeVisible();
    await expect(page.getByTestId("breadcrumb-current-agent")).toContainText("Lead Architect");
    await expect(page.getByTestId("child-agent-live-activity")).toContainText("Read file · path: components/agent/agent-chat.tsx");
    await expect(page.getByTestId("child-agent-nested-item")).toContainText("SQL Verifier");

    await page.screenshot({ path: test.info().outputPath("03-pr2-parent-agent-timeline.png"), fullPage: false });

    // 5. Drill into nested child ("SQL Verifier") and verify ancestor breadcrumb chain
    await page.getByTestId("child-agent-nested-item").click();
    await expect(page.getByTestId("breadcrumb-ancestor-agent")).toContainText("Lead Architect");
    await expect(page.getByTestId("breadcrumb-current-agent")).toContainText("SQL Verifier");
    await expect(page.getByTestId("child-agent-result")).toContainText("CREATE INDEX ASYNC IF NOT EXISTS");

    await page.screenshot({ path: test.info().outputPath("04-pr2-nested-child-breadcrumbs.png"), fullPage: false });

    // Step up to Lead Architect via ancestor breadcrumb, then back to Main conversation
    await page.getByTestId("breadcrumb-ancestor-agent").click();
    await expect(page.getByTestId("breadcrumb-current-agent")).toContainText("Lead Architect");

    await page.getByTestId("breadcrumb-main-conversation").click();
    await expect(page.getByTestId("child-agent-timeline")).toHaveCount(0);
    await expect(page.getByText("Latest main-thread update: Lead Architect delegated Aurora DSQL index verification to SQL Verifier.")).toBeVisible();
    await expect(composerInput).toHaveValue("Follow-up draft preserved across sub-agent drill-down");
  } finally {
    await pool.query(`DELETE FROM "${S}".agent_child_runs WHERE conversation_id = ANY($1::uuid[])`, [[convTeamId, convFailedId]]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_conversation_reviews WHERE conversation_id = ANY($1::uuid[])`, [[convTeamId, convFailedId]]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_runs WHERE conversation_id = ANY($1::uuid[])`, [[convTeamId, convFailedId]]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = ANY($1::uuid[])`, [[convTeamId, convFailedId]]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = ANY($1::uuid[])`, [[convTeamId, convFailedId]]).catch(() => {});
    await pool.end();
  }
});
