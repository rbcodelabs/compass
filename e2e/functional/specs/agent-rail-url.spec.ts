import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import type { Page } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * The agent rail's Help and Library state lives in the URL (rail / ra) so a
 * refresh or a shared link restores it, without the rail ever being remounted:
 * the params are mirrored with history.replaceState and re-applied after in-app
 * navigation.
 *
 * Old rail links (`?rc=<id>`) no longer belong to the rail: the legacy redirect
 * rewrites them to the Conversation panel's `?detail=conversation:<id>` (TASK-195
 * S5, design 4.5). A conversation is seeded straight into the database (no LLM).
 *
 * Set RAIL_URL_SHOTS=<dir> to also write the screenshots of the restored views.
 */
const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";

const rail = (page: Page) => page.locator('[data-slot="agent-rail"]');
// Below 1024px (or unpinned) the panel is a "Conversation" dialog; docked it is the pinned aside.
const panel = (page: Page) =>
  page.getByRole("dialog", { name: "Conversation", exact: true }).or(page.locator('[data-slot="pinned-panel"]'));
const params = (page: Page) => new URL(page.url()).searchParams;
const shot = async (page: Page, name: string) => {
  if (process.env.RAIL_URL_SHOTS) await page.screenshot({ path: `${process.env.RAIL_URL_SHOTS}/agent-rail-url-${name}.png` });
};

async function seedConversation(pool: pg.Pool, conversationId: string, title: string, question: string, reply: string) {
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
    [conversationId, question, ws.user_id, reply],
  );
}

async function cleanup(pool: pg.Pool, conversationId: string) {
  await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = $1`, [conversationId]).catch(() => undefined);
  await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = $1`, [conversationId]).catch(() => undefined);
  await pool.end();
}

test("old rail links (?rc=) redirect to the Conversation panel, and the rail's Help and Library state survives refresh and navigation", async ({
  page,
  base,
}) => {
  test.setTimeout(240_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const suffix = randomUUID().slice(0, 8);
  const conversationId = randomUUID();
  const seededReply = `Seeded answer ${suffix}`;
  const nav = page.getByRole("navigation", { name: "Main navigation" });

  try {
    await seedConversation(pool, conversationId, `Rail URL chat ${suffix}`, `Seeded question ${suffix}`, seededReply);

    // ── /okrs?rc=<id> ends at ?detail=conversation:<id>, no rc, thread in the panel ──
    await page.goto(`${base}/okrs?rc=${conversationId}`);
    await expect.poll(() => params(page).get("detail"), { timeout: 30_000 }).toBe(`conversation:${conversationId}`);
    expect(params(page).has("rc"), "rc is dropped").toBe(false);
    await expect(panel(page).getByText(seededReply)).toBeVisible({ timeout: 30_000 });
    // No redirect loop: the URL is stable.
    const settled = page.url();
    await page.waitForTimeout(2_000);
    expect(page.url()).toBe(settled);
    // replace(), not push: going back leaves the app rather than landing on the rc URL.
    await page.goBack();
    expect(page.url()).not.toContain("rc=");
    await shot(page, "rc-redirect");

    // ── Other params are kept ──────────────────────────────────────────────────
    await page.goto(`${base}/roadmap?foo=bar&rc=${conversationId}`);
    await expect.poll(() => params(page).get("detail"), { timeout: 30_000 }).toBe(`conversation:${conversationId}`);
    expect(params(page).get("foo")).toBe("bar");
    expect(params(page).has("rc")).toBe(false);

    // ── rail=help&ra=<slug>&rc=<id>: Help in the rail AND the thread in the panel ──
    await page.goto(`${base}/okrs?rail=help&ra=01-okrs&rc=${conversationId}`);
    await expect(page.getByTestId("docs-article")).toBeVisible({ timeout: 30_000 });
    await expect(panel(page).getByText(seededReply)).toBeVisible({ timeout: 30_000 });
    expect(params(page).get("rail")).toBe("help");
    expect(params(page).get("ra")).toBe("01-okrs");
    expect(params(page).get("detail")).toBe(`conversation:${conversationId}`);
    expect(params(page).has("rc")).toBe(false);

    // ── Help: view, article and restore ────────────────────────────────────────
    await page.goto(`${base}/okrs?rail=help`);
    await expect(rail(page)).toBeVisible({ timeout: 30_000 });
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
    await page.evaluate(() => {
      (document.querySelector('[data-slot="agent-rail"]') as HTMLElement).dataset.e2eMarker = "same-element";
    });
    await nav.getByRole("link", { name: "Roadmap", exact: true }).click();
    await expect(page).toHaveURL(/\/roadmap/);
    await expect.poll(() => params(page).get("rail")).toBe("library");
    await expect(rail(page)).toHaveAttribute("data-e2e-marker", "same-element");

    // …and a page's own params are left alone when the rail's are added or changed.
    await page.goto(`${base}/roadmap?foo=bar&rail=library`);
    await expect(rail(page)).toBeVisible({ timeout: 30_000 });
    await rail(page).getByRole("button", { name: /Rail view/ }).click();
    await page.getByRole("menuitem", { name: /Help/ }).click();
    await expect.poll(() => params(page).get("rail")).toBe("help");
    expect(params(page).get("foo")).toBe("bar");
    await nav.getByRole("link", { name: "OKRs", exact: true }).click();
    await expect(page).toHaveURL(/\/okrs/);
    await expect(rail(page)).toBeVisible();
  } finally {
    await cleanup(pool, conversationId);
  }
});

// Not-available state for an id the viewer cannot read. conversation-panel.tsx
// fetches /messages and /settings with no visible error handling today, so there
// is no such state to assert on; adding one is a product decision, not S5's.
test.fixme("TASK-195 S5: not-available state for non-member id", async ({ page, base }) => {
  await page.goto(`${base}/okrs?rc=${randomUUID()}`);
  await expect.poll(() => params(page).get("detail")).toMatch(/^conversation:/);
  await expect(panel(page).getByText(/not available/i)).toBeVisible();
});

// These steps existed only for the removed rail agent view. Whether the panel
// must survive in-app navigation while streaming is the separate panel-persistence
// task (design Q9). Kept, not deleted, so the intent is not lost.
test.fixme("TASK-195 follow-up: panel persistence across navigation", async ({ page, base }) => {
  const conversationId = randomUUID();
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  // 1. A streaming turn survives in-app navigation: hold **/api/agent/turn, send a
  //    message in the panel, mark the panel element, click a sidebar link, and
  //    assert the same DOM node (no remount) and a still-disabled "Open in full page".
  // 2. After release(), the streamed reply is visible and detail=conversation:<id> persists.
  // 3. "Open in full page" lands on /agent?c=<id>; navigating back reopens the panel on the same thread.
  await page.goto(`${base}/okrs?detail=conversation:${conversationId}`);
  await nav.getByRole("link", { name: "Roadmap", exact: true }).click();
  await expect(panel(page)).toBeVisible();
});

// "Rail view -> Agent" (the rail's own agent view) was removed with the rail agent view.
test.fixme("TASK-195 follow-up: panel persistence across navigation (rail Agent view round trip)", async ({ page, base }) => {
  await page.goto(`${base}/okrs?rail=library`);
  await rail(page).getByRole("button", { name: /Rail view/ }).click();
  await page.getByRole("menuitem", { name: /Agent/ }).click();
  await expect.poll(() => params(page).has("rail")).toBe(false);
});
