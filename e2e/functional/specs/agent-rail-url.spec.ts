import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import type { Page } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * The agent rail's state lives in the URL (rail / rc / ra) so a refresh or a
 * shared link restores it, without the rail ever being remounted: the params are
 * mirrored with history.replaceState, and re-applied after in-app navigation.
 *
 * A conversation is seeded straight into the database (no LLM). The one turn the
 * spec sends is answered by a mocked /api/agent/turn that is *held* until the
 * test has navigated away, so "the stream survives navigation" is observed with
 * a request genuinely in flight rather than inferred.
 *
 * Set RAIL_URL_SHOTS=<dir> to also write the screenshots of the restored views.
 */
const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";

const rail = (page: Page) => page.locator('[data-slot="agent-rail"]');
const params = (page: Page) => new URL(page.url()).searchParams;
const shot = async (page: Page, name: string) => {
  if (process.env.RAIL_URL_SHOTS) await page.screenshot({ path: `${process.env.RAIL_URL_SHOTS}/agent-rail-url-${name}.png` });
};

test("the rail's view, thread and Help article survive refresh, share by link, carry across navigation, and never remount a streaming turn", async ({
  page,
  base,
  browser,
}) => {
  test.setTimeout(240_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const suffix = randomUUID().slice(0, 8);
  const conversationId = randomUUID();
  const title = `Rail URL chat ${suffix}`;
  const seededQuestion = `Seeded question ${suffix}`;
  const seededReply = `Seeded answer ${suffix}`;
  const streamedReply = `Streamed answer ${suffix}`;
  const nav = page.getByRole("navigation", { name: "Main navigation" });

  try {
    const { rows: [ws] } = await pool.query<{ id: string; user_id: string }>(
      `SELECT w.id, (SELECT id FROM "${S}".users WHERE email = 'dev@localhost.dev') AS user_id
         FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id
        WHERE o.slug = $1 AND w.slug = $2`,
      [ORG, WORKSPACE],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [conversationId, ws.id, ws.user_id, title],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
       VALUES (gen_random_uuid(), $1, 'user', $2, $3, NOW() - interval '2 seconds'),
              (gen_random_uuid(), $1, 'assistant', $4, NULL, NOW() - interval '1 second')`,
      [conversationId, seededQuestion, ws.user_id, seededReply],
    );

    // ── Open the rail on a thread: the URL follows, nothing navigates ──────────
    await page.goto(`${base}/okrs`);
    await expect(nav.getByRole("link", { name: "OKRs", exact: true })).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("ControlOrMeta+j");
    await expect(rail(page)).toBeVisible();
    expect(params(page).has("rc"), "a fresh chat is the default and leaves the URL clean").toBe(false);
    await rail(page).getByRole("button", { name: "Switch conversation" }).click();
    await page.getByRole("menuitem", { name: title }).click();
    await expect(rail(page).getByText(seededReply)).toBeVisible();
    await expect.poll(() => params(page).get("rc")).toBe(conversationId);

    // ── Refresh restores the Agent view and the thread ─────────────────────────
    await page.reload();
    await expect(rail(page)).toBeVisible({ timeout: 30_000 });
    await expect(rail(page).getByText(seededReply)).toBeVisible();
    expect(params(page).get("rc")).toBe(conversationId);
    await shot(page, "agent");

    // ── A shared link opens the rail for someone whose cookie says closed ──────
    const guest = await browser.newContext({ storageState: await page.context().storageState(), baseURL: test.info().project.use.baseURL as string });
    const guestPage = await guest.newPage();
    await guestPage.context().clearCookies({ name: "compass_panel_agent" });
    await guestPage.goto(`${base}/roadmap?rc=${conversationId}`);
    await expect(rail(guestPage)).toBeVisible({ timeout: 30_000 });
    await expect(rail(guestPage).getByText(seededReply)).toBeVisible();
    await guest.close();

    // ── Help: view, article and restore ────────────────────────────────────────
    await rail(page).getByRole("button", { name: /Rail view/ }).click();
    await page.getByRole("menuitem", { name: /Help/ }).click();
    await expect.poll(() => params(page).get("rail")).toBe("help");
    expect(params(page).get("rc"), "the thread is kept while another view shows").toBe(conversationId);
    await page.reload();
    await expect(page.getByTestId("docs-home")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("docs-home").getByText("Loading…")).toHaveCount(0);
    await shot(page, "help-home");

    await page.locator('[data-testid="docs-home"] section ul button').first().click();
    await expect(page.getByTestId("docs-article")).toBeVisible();
    await expect.poll(() => params(page).get("ra")).not.toBeNull();
    const article = params(page).get("ra")!;
    await page.reload();
    await expect(page.getByTestId("docs-article")).toBeVisible({ timeout: 30_000 });
    expect(params(page).get("ra")).toBe(article);
    await shot(page, "help-article");

    // ── Library ────────────────────────────────────────────────────────────────
    await rail(page).getByRole("button", { name: /Rail view/ }).click();
    await page.getByRole("menuitem", { name: /Library/ }).click();
    await expect.poll(() => params(page).get("rail")).toBe("library");
    expect(params(page).has("ra"), "the article is only mirrored while Help shows").toBe(false);
    await page.reload();
    await expect(page.getByTestId("rail-library")).toBeVisible({ timeout: 30_000 });
    await expect(rail(page).getByRole("button", { name: "Rail view: Library" })).toBeVisible();
    await expect(page.getByTestId("rail-library").getByText("Loading…")).toHaveCount(0);
    await shot(page, "library");

    // ── Navigating via the sidebar keeps the rail, its state and its element ───
    await rail(page).getByRole("button", { name: /Rail view/ }).click();
    await page.getByRole("menuitem", { name: /Agent/ }).click();
    await expect.poll(() => params(page).has("rail")).toBe(false);
    await page.evaluate(() => {
      (document.querySelector('[data-slot="agent-rail"]') as HTMLElement).dataset.e2eMarker = "same-element";
    });
    await nav.getByRole("link", { name: "Roadmap", exact: true }).click();
    await expect(page).toHaveURL(/\/roadmap/);
    await expect.poll(() => params(page).get("rc")).toBe(conversationId);
    await expect(rail(page)).toHaveAttribute("data-e2e-marker", "same-element");

    // …and a page's own params are left alone when the rail's are added or changed.
    await page.goto(`${base}/roadmap?foo=bar&rc=${conversationId}`);
    await expect(rail(page)).toBeVisible({ timeout: 30_000 });
    await rail(page).getByRole("button", { name: "New chat" }).click();
    await expect.poll(() => params(page).has("rc")).toBe(false);
    expect(params(page).get("foo")).toBe("bar");
    await nav.getByRole("link", { name: "OKRs", exact: true }).click();
    await expect(page).toHaveURL(/\/okrs/);
    await expect(rail(page)).toBeVisible();

    // ── A streaming turn survives navigation (no remount, request still live) ──
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/agent/turn", async (route) => {
      await held;
      const events =
        `event: status\ndata: ${JSON.stringify({ phase: "running", conversationId })}\n\n` +
        `event: result\ndata: ${JSON.stringify({ text: streamedReply, conversationId })}\n\n`;
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: events });
    });
    await rail(page).getByRole("button", { name: "New chat" }).click();
    await expect.poll(() => params(page).has("rc")).toBe(false);
    await rail(page).getByPlaceholder(/message the agent/i).fill(`Streaming question ${suffix}`);
    await rail(page).getByRole("button", { name: "Send message" }).click();
    await expect(rail(page).getByRole("button", { name: "Open in full page" }), "mid-turn").toBeDisabled();
    await page.evaluate(() => {
      (document.querySelector('[data-slot="agent-rail"]') as HTMLElement).dataset.e2eMarker = "mid-turn";
    });

    await nav.getByRole("link", { name: "Roadmap", exact: true }).click();
    await expect(page).toHaveURL(/\/roadmap/);
    await expect(rail(page), "same DOM node: not remounted").toHaveAttribute("data-e2e-marker", "mid-turn");
    await expect(rail(page).getByRole("button", { name: "Open in full page" }), "still streaming after navigating").toBeDisabled();

    release();
    await expect(rail(page).getByText(streamedReply)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => params(page).get("rc")).toBe(conversationId);

    // ── Expand to the full page keeps the thread, and leaving restores the rail ─
    await expect(rail(page).getByRole("button", { name: "Open in full page" })).toBeEnabled();
    await rail(page).getByRole("button", { name: "Open in full page" }).click();
    await expect(page).toHaveURL(new RegExp(`/agent\\?c=${conversationId}`));
    await expect(page.getByText(seededReply)).toBeVisible({ timeout: 30_000 });
    await expect(rail(page)).toHaveCount(0);
    // Back out the in-app way (a reload would discard client state): the page's
    // ?c= is adopted by the rail, so reopening it lands on the same thread.
    await nav.getByRole("link", { name: "Roadmap", exact: true }).click();
    await expect(page).toHaveURL(/\/roadmap/);
    // The rail preference was never touched, so it is simply back, on the thread.
    await expect(rail(page)).toBeVisible();
    await expect.poll(() => params(page).get("rc")).toBe(conversationId);
    await expect(rail(page).getByText(seededReply)).toBeVisible();
  } finally {
    await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = $1`, [conversationId]).catch(() => undefined);
    await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = $1`, [conversationId]).catch(() => undefined);
    await pool.end();
  }
});
