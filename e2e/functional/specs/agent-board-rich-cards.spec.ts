import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import type { Page } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Rich agent board & chat sidebar (PR 1):
 *   - Live workspace SSE stream (`/api/agent/board/stream`) delivering `snapshot` + `patch` updates without reload
 *   - Rich BoardCard anatomy: live `currentActivity`, stale-heartbeat amber state, idle 2-line `summary`,
 *     inline subtask progress bar + checklist (`completed/total`), `PR #N` badge, Squad pill, and linked `OPP` / `SOL` chips
 *   - Search bar (`Search threads, tasks, activity…`) filtering across titles, subtasks, activity, PRs, and linked objects
 *   - `Group: Status | Squad` toggle on both the Board and the Chat left sidebar
 */
const S = "compass_dev";
const SHOTS = path.join(process.cwd(), "test-results", "agent-board-rich-cards");

function capturePageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.log(`[pageerror] ${error.message}\n${error.stack ?? "(no stack)"}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error" && /Cannot update a component|Base UI:/.test(msg.text())) {
      errors.push(msg.text());
    }
  });
  return errors;
}

test("renders rich board cards, streams live SSE patches, filters search, and groups by Status and Squad on board and chat sidebar", async ({ page, base }) => {
  test.setTimeout(240_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const pageErrors = capturePageErrors(page);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const suffix = randomUUID().slice(0, 8);

  const squadPlatform = { id: randomUUID(), name: `Platform ${suffix}`, color: "#4f46e5" };
  const squadGrowth = { id: randomUUID(), name: `Growth ${suffix}`, color: "#0d9488" };

  const convWorking = { id: randomUUID(), title: `Implement live board SSE stream ${suffix}` };
  const convStale = { id: randomUUID(), title: `Run heavy migration verification ${suffix}` };
  const convReview = { id: randomUUID(), title: `Ship rich agent card anatomy ${suffix}` };
  const convDone = { id: randomUUID(), title: `Audit workspace capability packs ${suffix}` };

  const oppId = randomUUID();
  const solId = randomUUID();
  const taskDoneId = randomUUID();
  const taskActiveId = randomUUID();
  const taskTodoId = randomUUID();
  const createdLinkIds: string[] = [];

  try {
    const { rows: [ids] } = await pool.query<{ workspace_id: string; owner_id: string }>(
      `SELECT w.id AS workspace_id, (SELECT id FROM "${S}".users WHERE email = 'dev@localhost.dev') AS owner_id
         FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id
        WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace'`,
    );
    const workspaceId = ids.workspace_id;
    const userId = ids.owner_id;

    // 1. Seed Squads
    await pool.query(
      `INSERT INTO "${S}".squads (id, workspace_id, name, color) VALUES ($1, $2, $3, $4), ($5, $2, $6, $7)`,
      [squadPlatform.id, workspaceId, squadPlatform.name, squadPlatform.color, squadGrowth.id, squadGrowth.name, squadGrowth.color],
    );

    // 2. Seed rich AgentConversations
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, squad_id, summary, pr_url, created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, $5, NULL, NULL, NOW() - interval '2 minutes', NOW() - interval '1 minute'),
         ($6, $2, $3, $7, $5, NULL, NULL, NOW() - interval '5 minutes', NOW() - interval '3 minutes'),
         ($8, $2, $3, $9, $10, 'Added inline subtask checklists, PR chips, and live SSE patch diffing across board columns.', 'https://github.com/rbcodelabs/compass/pull/560', NOW() - interval '12 minutes', NOW() - interval '8 minutes'),
         ($11, $2, $3, $12, NULL, 'Verified all 14 capability pack manifests and permissions cleanly.', NULL, NOW() - interval '30 minutes', NOW() - interval '25 minutes')`,
      [
        convWorking.id, workspaceId, userId, convWorking.title, squadPlatform.id,
        convStale.id, convStale.title,
        convReview.id, convReview.title, squadGrowth.id,
        convDone.id, convDone.title,
      ],
    );

    // Seed messages so conversations count as non-empty
    for (const [cid, answer] of [
      [convWorking.id, "Streaming SSE patches now."],
      [convStale.id, "Checking schema postconditions."],
      [convReview.id, "Opened https://github.com/rbcodelabs/compass/pull/560 with rich card UI."],
      [convDone.id, "Completed pack audit."],
    ] as const) {
      await pool.query(
        `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
         VALUES (gen_random_uuid(), $1, 'user', 'Please handle this task', $2, NOW() - interval '10 minutes'),
                (gen_random_uuid(), $1, 'assistant', $3, NULL, NOW() - interval '9 minutes')`,
        [cid, userId, answer],
      );
    }

    // Mark `convDone` as reviewed
    await pool.query(
      `INSERT INTO "${S}".agent_conversation_reviews (id, conversation_id, workspace_id, user_id, reviewed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW())`,
      [convDone.id, workspaceId, userId],
    );

    // 3. Seed AgentRuns (fresh heartbeat on convWorking, stale >45s heartbeat on convStale, SUCCEEDED on convReview & convDone)
    const tokenHash = () => randomUUID().replaceAll("-", "").padEnd(64, "0");
    await pool.query(
      `INSERT INTO "${S}".agent_runs (id, conversation_id, workspace_id, user_id, status, substatus, current_activity, last_heartbeat_at, worker_token_hash, deadline_at, status_changed_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, 'RUNNING', 'tool', 'Editing components/agent/agent-board.tsx', NOW(), $4, NOW() + interval '1 hour', NOW() - interval '1 minute'),
         (gen_random_uuid(), $5, $2, $3, 'RUNNING', 'thinking', NULL, NOW() - interval '3 minutes', $6, NOW() + interval '1 hour', NOW() - interval '3 minutes'),
         (gen_random_uuid(), $7, $2, $3, 'SUCCEEDED', NULL, NULL, NULL, $8, NOW() + interval '1 hour', NOW() - interval '8 minutes'),
         (gen_random_uuid(), $9, $2, $3, 'SUCCEEDED', NULL, NULL, NULL, $10, NOW() + interval '1 hour', NOW() - interval '25 minutes')`,
      [
        convWorking.id, workspaceId, userId, tokenHash(),
        convStale.id, tokenHash(),
        convReview.id, tokenHash(),
        convDone.id, tokenHash(),
      ],
    );

    // 4. Seed Subtasks on `convWorking` (`1/3` completed) and Opportunity + Solution chips on `convReview`
    await pool.query(
      `INSERT INTO "${S}".tasks (id, workspace_id, title, status, sort_order)
       VALUES
         ($1, $2, 'Add 119_agent_board_rich_cards migration', 'DONE', 1),
         ($3, $2, 'Stream live board patches over SSE', 'IN_PROGRESS', 2),
         ($4, $2, 'Verify Squad column grouping in E2E', 'TODO', 3)`,
      [taskDoneId, workspaceId, taskActiveId, taskTodoId],
    );
    for (const tid of [taskDoneId, taskActiveId, taskTodoId]) {
      const linkId = randomUUID();
      createdLinkIds.push(linkId);
      await pool.query(
        `INSERT INTO "${S}".entity_links (id, workspace_id, link_type, from_type, from_id, to_type, to_id, origin, source, created_at, updated_at)
         VALUES ($1, $2, 'TASK_CREATED_FROM', 'TASK', $3, 'AGENT_CONVERSATION', $4, 'DIRECT', 'AGENT', NOW(), NOW())`,
        [linkId, workspaceId, tid, convWorking.id],
      );
    }

    await pool.query(
      `INSERT INTO "${S}".opportunities (id, workspace_id, title) VALUES ($1, $2, $3)`,
      [oppId, workspaceId, `Multi-agent visibility gap ${suffix}`],
    );
    await pool.query(
      `INSERT INTO "${S}".solutions (id, workspace_id, opportunity_id, title) VALUES ($1, $2, $3, $4)`,
      [solId, workspaceId, oppId, `Geode-grade Agent Board ${suffix}`],
    );
    for (const [toType, toId] of [["OPPORTUNITY", oppId], ["SOLUTION", solId]] as const) {
      const linkId = randomUUID();
      createdLinkIds.push(linkId);
      await pool.query(
        `INSERT INTO "${S}".entity_links (id, workspace_id, link_type, from_type, from_id, to_type, to_id, origin, source, created_at, updated_at)
         VALUES ($1, $2, 'CONVERSATION_CREATED', 'AGENT_CONVERSATION', $3, $4, $5, 'DIRECT', 'AGENT', NOW(), NOW())`,
        [linkId, workspaceId, convReview.id, toType, toId],
      );
    }

    // ── 1. Open Agent page -> Board tab (Status view) ─────────────────────────
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/agent`);
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    await expect(page.getByTestId("agent-board")).toBeVisible({ timeout: 30_000 });

    const workingCard = page.locator(`[data-board-card="${convWorking.id}"]`);
    const staleCard = page.locator(`[data-board-card="${convStale.id}"]`);
    const reviewCard = page.locator(`[data-board-card="${convReview.id}"]`);

    await expect(workingCard).toBeVisible({ timeout: 15_000 });
    await expect(workingCard.getByTestId("board-card-live-activity")).toContainText("Editing components/agent/agent-board.tsx");
    await expect(workingCard.getByTestId("board-card-squad-badge")).toContainText(squadPlatform.name);
    await expect(workingCard.getByTestId("board-card-subtasks")).toContainText("1/3");
    await expect(workingCard.getByTestId("board-card-subtasks")).toContainText("Stream live board patches over SSE");

    // Fresh heartbeat card spins actively (not delayed)
    await expect(workingCard.locator('[data-stale="true"]')).toHaveCount(0);
    await expect(workingCard).toContainText("Working");

    // Stale heartbeat card shows paused amber spinner + Delayed label
    await expect(staleCard).toBeVisible();
    await expect(staleCard.locator('[data-stale="true"]')).toHaveCount(1);
    await expect(staleCard).toContainText("Delayed");

    // Idle review card shows 2-line summary, PR #560 badge, Squad badge, and OPP / SOL chips
    await expect(reviewCard).toBeVisible();
    await expect(reviewCard.getByTestId("board-card-summary")).toContainText("Added inline subtask checklists");
    await expect(reviewCard.getByTestId("board-card-pr-badge")).toContainText("PR #560");
    await expect(reviewCard.getByTestId("board-card-linked-chip")).toHaveCount(2);

    await page.screenshot({ path: path.join(SHOTS, "01-board-status-rich-cards.png") });

    // ── 2. Switch Board to `Group: Squad` ─────────────────────────────────────
    await page.getByRole("button", { name: "Squad", exact: true }).click();
    await expect(page.getByRole("region", { name: "Agent conversations by squad" })).toBeVisible();
    await expect(page.locator(`[data-board-column="squad:${squadPlatform.id}"]`).locator(`[data-board-card="${convWorking.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-board-column="squad:${squadGrowth.id}"]`).locator(`[data-board-card="${convReview.id}"]`)).toBeVisible();
    await expect(page.locator('[data-board-column="squad:unassigned"]').locator(`[data-board-card="${convDone.id}"]`)).toBeVisible();

    await page.screenshot({ path: path.join(SHOTS, "02-board-squad-columns.png") });

    // ── 3. Search bar filters across PR number, subtask title, and linked object ─
    await page.getByRole("button", { name: "Status", exact: true }).click();
    const searchInput = page.getByRole("searchbox", { name: "Search agent threads" });
    await searchInput.fill("#560");
    await expect(reviewCard).toBeVisible();
    await expect(workingCard).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, "03-board-search-filtered.png") });
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(workingCard).toBeVisible();

    // ── 4. Live SSE patch updates subtask count and activity in-place without reload ─
    await pool.query(`UPDATE "${S}".tasks SET status = 'DONE', updated_at = NOW() WHERE id = $1`, [taskActiveId]);
    await pool.query(
      `UPDATE "${S}".agent_runs SET current_activity = 'Running Playwright verification', last_heartbeat_at = NOW() WHERE conversation_id = $1`,
      [convWorking.id],
    );
    await expect(workingCard.getByTestId("board-card-subtasks")).toContainText("2/3", { timeout: 15_000 });
    await expect(workingCard.getByTestId("board-card-live-activity")).toContainText("Running Playwright verification");

    // ── 5. Switch to Chat tab: verify left sidebar Status & Squad grouping + rich rows ─
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    const historyNav = page.getByRole("complementary", { name: "Chat history" });
    await expect(historyNav).toBeVisible();
    await expect(historyNav).toContainText("Running Playwright verification");
    await expect(historyNav).toContainText("2/3");
    await expect(historyNav).toContainText("#560");
    await page.screenshot({ path: path.join(SHOTS, "04-chat-sidebar-status-rich.png") });

    await historyNav.getByRole("button", { name: "Squad", exact: true }).click();
    await expect(historyNav).toContainText(squadPlatform.name);
    await expect(historyNav).toContainText(squadGrowth.name);
    await page.screenshot({ path: path.join(SHOTS, "05-chat-sidebar-squad-grouped.png") });

    expect(pageErrors).toEqual([]);
  } finally {
    const convIds = [convWorking.id, convStale.id, convReview.id, convDone.id];
    const taskIds = [taskDoneId, taskActiveId, taskTodoId];
    const squadIds = [squadPlatform.id, squadGrowth.id];
    if (createdLinkIds.length > 0) {
      await pool.query(`DELETE FROM "${S}".entity_links WHERE id = ANY($1::uuid[])`, [createdLinkIds]).catch(() => {});
    }
    await pool.query(`DELETE FROM "${S}".tasks WHERE id = ANY($1::uuid[])`, [taskIds]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".solutions WHERE id = $1`, [solId]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".opportunities WHERE id = $1`, [oppId]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_conversation_reviews WHERE conversation_id = ANY($1::uuid[])`, [convIds]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_runs WHERE conversation_id = ANY($1::uuid[])`, [convIds]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = ANY($1::uuid[])`, [convIds]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = ANY($1::uuid[])`, [convIds]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".squads WHERE id = ANY($1::uuid[])`, [squadIds]).catch(() => {});
    await pool.end();
  }
});
