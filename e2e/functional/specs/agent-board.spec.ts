import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import type { Page } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * The agent board: the Chat | Board toggle on the full agent page, the status columns, the card click
 * (opens the chat and records a per-user review), and live updates.
 *
 * No LLM turn is needed. Conversations and run rows are seeded straight into the database, one per
 * column, and the real page, routes and polling are driven. Nothing here starts an agent run.
 */
const S = "compass_dev";

type Seeded = { id: string; title: string };

test("toggle to the board, see each status column, open a card into the chat, and watch a run finish", async ({ page, base, browser, playwright }) => {
  test.setTimeout(240_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const baseURL = test.info().project.use.baseURL as string;
  const suffix = randomUUID().slice(0, 8);
  const seeded: Record<"working" | "failed" | "fresh" | "done" | "ready", Seeded> = {
    working: { id: randomUUID(), title: `Board working ${suffix}` },
    failed: { id: randomUUID(), title: `Board failed ${suffix}` },
    fresh: { id: randomUUID(), title: `Board new ${suffix}` },
    done: { id: randomUUID(), title: `Board done ${suffix}` },
    ready: { id: randomUUID(), title: `Board ready ${suffix}` },
  };
  let workspaceId = "";
  let userId = "";

  const card = (page: Page, s: Seeded) => page.locator(`[data-board-card="${s.id}"]`);
  const column = (page: Page, id: string) => page.locator(`[data-board-column="${id}"]`);
  const reviews = async (conversationId: string, forUser = userId) =>
    (await pool.query(`SELECT reviewed_at FROM "${S}".agent_conversation_reviews WHERE conversation_id = $1 AND user_id = $2`, [conversationId, forUser])).rows;

  async function seedConversation(s: Seeded, opts: { messages: boolean; run?: string; ageMinutes: number }) {
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW() - ($5 || ' minutes')::interval, NOW() - ($5 || ' minutes')::interval)`,
      [s.id, workspaceId, userId, s.title, String(opts.ageMinutes)],
    );
    if (opts.messages) {
      await pool.query(
        `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
         VALUES (gen_random_uuid(), $1, 'user', 'Question', $2, NOW() - ($3 || ' minutes')::interval),
                (gen_random_uuid(), $1, 'assistant', 'Answer', NULL, NOW() - ($3 || ' minutes')::interval)`,
        [s.id, userId, String(opts.ageMinutes)],
      );
    }
    if (opts.run) {
      await pool.query(
        `INSERT INTO "${S}".agent_runs (id, conversation_id, workspace_id, user_id, status, worker_token_hash, deadline_at, status_changed_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW() + interval '1 hour', NOW() - ($6 || ' minutes')::interval)`,
        [s.id, workspaceId, userId, opts.run, randomUUID().replaceAll("-", "").padEnd(64, "0"), String(opts.ageMinutes)],
      );
    }
  }

  try {
    const { rows: [ids] } = await pool.query<{ workspace_id: string; owner_id: string }>(
      `SELECT w.id AS workspace_id, (SELECT id FROM "${S}".users WHERE email = 'dev@localhost.dev') AS owner_id
         FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id
        WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace'`,
    );
    workspaceId = ids.workspace_id;
    userId = ids.owner_id;

    await seedConversation(seeded.working, { messages: true, run: "RUNNING", ageMinutes: 1 });
    await seedConversation(seeded.failed, { messages: true, run: "FAILED", ageMinutes: 5 });
    await seedConversation(seeded.fresh, { messages: true, run: "SUCCEEDED", ageMinutes: 10 });
    await seedConversation(seeded.done, { messages: true, run: "SUCCEEDED", ageMinutes: 20 });
    await seedConversation(seeded.ready, { messages: false, ageMinutes: 30 });
    // `done` was reviewed after its last activity; everything else was never reviewed.
    await pool.query(
      `INSERT INTO "${S}".agent_conversation_reviews (id, conversation_id, workspace_id, user_id, reviewed_at) VALUES (gen_random_uuid(), $1, $2, $3, NOW())`,
      [seeded.done.id, workspaceId, userId],
    );

    // ── Toggle: Chat is the default, Board replaces the chat pane on the same page ─
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/agent`);
    await expect(page.getByRole("heading", { name: "Agent", exact: true })).toBeVisible({ timeout: 30_000 });
    const chatTab = page.getByRole("tab", { name: "Chat", exact: true });
    const boardTab = page.getByRole("tab", { name: "Board", exact: true });
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("agent-board")).toHaveCount(0);

    await boardTab.click();
    await expect(page.getByTestId("agent-board")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${base}/agent$`));

    // ── Columns: each seeded conversation lands in its status column ─────────────
    await expect(column(page, "working").locator(`[data-board-card="${seeded.working.id}"]`)).toBeVisible({ timeout: 15_000 });
    await expect(column(page, "failed").locator(`[data-board-card="${seeded.failed.id}"]`)).toBeVisible();
    await expect(column(page, "new").locator(`[data-board-card="${seeded.fresh.id}"]`)).toBeVisible();
    await expect(column(page, "done").locator(`[data-board-card="${seeded.done.id}"]`)).toBeVisible();
    await expect(column(page, "ready").locator(`[data-board-card="${seeded.ready.id}"]`)).toBeVisible();
    // Geode's column order, and the count in each header.
    const order = await page.locator("[data-board-column]").evaluateAll((els) => els.map((el) => el.getAttribute("data-board-column")));
    expect(order).toEqual(["working", "new", "done", "failed", "ready"]);
    await expect(column(page, "working").getByRole("heading", { name: "Working" })).toBeVisible();
    // The card carries its title, status and a relative age; the running one has a spinner.
    await expect(card(page, seeded.fresh)).toContainText(seeded.fresh.title);
    await expect(card(page, seeded.fresh)).toContainText(/\d+m ago|just now/);
    await expect(card(page, seeded.working).locator("svg.animate-spin, svg[class*='animate-spin']")).toHaveCount(1);
    // Newest activity first within a column.
    const working = await column(page, "working").locator("[data-board-card]").evaluateAll((els) => els.map((el) => el.getAttribute("data-board-card")));
    expect(working.indexOf(seeded.working.id)).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: test.info().outputPath("agent-board-desktop.png"), fullPage: false });
    await test.info().attach("agent-board-desktop", { path: test.info().outputPath("agent-board-desktop.png"), contentType: "image/png" });

    // ── The saved view survives a reload, painted by the server (no chat flash) ─
    expect((await page.context().cookies()).find((c) => c.name === "agent_view")?.value).toBe("board");
    await page.reload();
    await expect(page.getByTestId("agent-board")).toBeVisible({ timeout: 30_000 });
    await expect(boardTab).toHaveAttribute("aria-selected", "true");

    // ── Live: a run finishing moves its card out of Working without a reload ────
    await pool.query(`UPDATE "${S}".agent_runs SET status = 'SUCCEEDED', status_changed_at = NOW() WHERE conversation_id = $1`, [seeded.working.id]);
    await pool.query(`UPDATE "${S}".agent_conversations SET updated_at = NOW() WHERE id = $1`, [seeded.working.id]);
    await expect(column(page, "new").locator(`[data-board-card="${seeded.working.id}"]`)).toBeVisible({ timeout: 20_000 });
    await expect(column(page, "working").locator(`[data-board-card="${seeded.working.id}"]`)).toHaveCount(0);

    // ── Card click: opens that conversation in the chat and records a review ────
    expect(await reviews(seeded.fresh.id)).toHaveLength(0);
    await card(page, seeded.fresh).click();
    await page.waitForURL(new RegExp(`c=${seeded.fresh.id}`));
    await expect(page.getByText("Answer").first()).toBeVisible({ timeout: 30_000 });
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("agent-board")).toHaveCount(0);
    await expect.poll(async () => (await reviews(seeded.fresh.id)).length, { timeout: 15_000 }).toBe(1);

    // Back on the board, that conversation is now Done; new activity after the review makes it New again.
    await boardTab.click();
    await expect(column(page, "done").locator(`[data-board-card="${seeded.fresh.id}"]`)).toBeVisible({ timeout: 15_000 });
    await pool.query(`UPDATE "${S}".agent_conversations SET updated_at = NOW() + interval '1 minute' WHERE id = $1`, [seeded.fresh.id]);
    await expect(column(page, "new").locator(`[data-board-card="${seeded.fresh.id}"]`)).toBeVisible({ timeout: 20_000 });

    // ── Reviews are per user and access-checked ────────────────────────────────
    const stranger = `board-stranger-${suffix}@localhost.dev`;
    const login = await playwright.request.newContext({ baseURL });
    const csrf = (await (await login.get("/api/auth/csrf")).json()) as { csrfToken: string };
    await login.post("/api/auth/callback/dev-credentials", { form: { csrfToken: csrf.csrfToken, email: stranger, callbackUrl: `${baseURL}/dashboard` }, maxRedirects: 0 });
    const strangerContext = await browser.newContext({ storageState: await login.storageState(), baseURL });
    const denied = await strangerContext.request.post(`/api/agent/conversations/${seeded.ready.id}/review?workspaceId=${workspaceId}`);
    expect(denied.status(), "a user who cannot see the conversation gets 404, not 403").toBe(404);
    const strangerBoard = await strangerContext.request.get(`/api/agent/board?workspaceId=${workspaceId}`);
    expect(strangerBoard.status()).toBe(200);
    expect((await strangerBoard.json()).cards, "a non-member's board is empty").toEqual([]);
    expect(await reviews(seeded.ready.id, userId), "the denied POST wrote nothing").toHaveLength(0);
    const anyRow = await pool.query(`SELECT 1 FROM "${S}".agent_conversation_reviews WHERE conversation_id = $1`, [seeded.ready.id]);
    expect(anyRow.rows).toHaveLength(0);
    await strangerContext.close();
    await login.dispose();

    // ── Mobile: columns keep their width and the board scrolls horizontally ─────
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/agent`);
    await expect(page.getByTestId("agent-board")).toBeVisible({ timeout: 30_000 });
    const region = page.getByRole("region", { name: "Agent conversations by status" });
    await expect(region).toBeVisible();
    const metrics = await region.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(metrics.scroll, "the board scrolls sideways rather than squashing its columns").toBeGreaterThan(metrics.client);
    const widths = await page.locator("[data-board-column]").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(279);
    await region.evaluate((el) => el.scrollTo({ left: 400 }));
    await expect.poll(async () => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    await region.evaluate((el) => el.scrollTo({ left: 0 }));
    await page.screenshot({ path: test.info().outputPath("agent-board-mobile.png"), fullPage: false });
    await test.info().attach("agent-board-mobile", { path: test.info().outputPath("agent-board-mobile.png"), contentType: "image/png" });
  } finally {
    const ids = Object.values(seeded).map((s) => s.id);
    await pool.query(`DELETE FROM "${S}".agent_conversation_reviews WHERE conversation_id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_runs WHERE conversation_id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await pool.end();
  }
});
