import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import type { Page } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * A rail link (rc / rail=help&ra / rail=library) loaded on a phone and in dark
 * mode: the rail must render usably (below md it is the overlay drawer), the page
 * must not overflow sideways, and closing it must leave the page free and the
 * URL clean. Seeded conversation, no LLM.
 *
 * Writes screenshots when RAIL_URL_SHOTS=<dir> is set.
 */
const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";

const rail = (page: Page) => page.locator('[data-slot="agent-rail"]');

const VIEWPORTS = [
  { name: "mobile-390-light", width: 390, height: 844, scheme: "light" as const },
  { name: "mobile-390-dark", width: 390, height: 844, scheme: "dark" as const },
  { name: "desktop-1280-dark", width: 1280, height: 800, scheme: "dark" as const },
];

test("rail links load usably on a phone and in dark mode, and close cleanly", async ({ page, base }) => {
  test.setTimeout(240_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const conversationId = randomUUID();
  const seededReply = `Seeded answer ${conversationId.slice(0, 8)}`;
  try {
    const { rows: [ws] } = await pool.query<{ id: string; user_id: string }>(
      `SELECT w.id, (SELECT id FROM "${S}".users WHERE email = 'dev@localhost.dev') AS user_id
         FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id
        WHERE o.slug = $1 AND w.slug = $2`,
      [ORG, WORKSPACE],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, created_at, updated_at)
       VALUES ($1, $2, $3, 'Viewport chat', NOW(), NOW())`,
      [conversationId, ws.id, ws.user_id],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
       VALUES (gen_random_uuid(), $1, 'user', 'Seeded question', $3, NOW() - interval '2 seconds'),
              (gen_random_uuid(), $1, 'assistant', $2, NULL, NOW() - interval '1 second')`,
      [conversationId, seededReply, ws.user_id],
    );

    const states = [
      { name: "agent", query: `rc=${conversationId}`, ready: () => rail(page).getByText(seededReply) },
      { name: "help-article", query: "rail=help&ra=01-okrs", ready: () => page.getByTestId("docs-article") },
      { name: "library", query: "rail=library", ready: () => page.getByTestId("rail-library").getByText("Library", { exact: true }) },
    ];

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.emulateMedia({ colorScheme: vp.scheme });
      for (const state of states) {
        // A fresh browser context per link would be purer, but the cookie is the
        // only carried state and a rail param must win over it either way.
        await page.context().clearCookies({ name: "compass_panel_agent" });
        await page.goto(`${base}/okrs?${state.query}`);
        await expect(rail(page), `${vp.name}/${state.name}: rail opens from the link`).toBeVisible({ timeout: 30_000 });
        await expect(state.ready()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId("docs-home").getByText("Loading…")).toHaveCount(0);

        const box = (await rail(page).boundingBox())!;
        expect(box.x, `${vp.name}/${state.name}: rail starts on screen`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${vp.name}/${state.name}: rail ends on screen`).toBeLessThanOrEqual(vp.width + 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll").toBe(true);
        console.log(`${vp.name}/${state.name}: mode=${await rail(page).getAttribute("data-mode")} box=${Math.round(box.x)},${Math.round(box.width)}`);
        if (process.env.RAIL_URL_SHOTS) {
          await page.screenshot({ path: `${process.env.RAIL_URL_SHOTS}/${vp.name}-${state.name}.png` });
        }

        // Closing is not stuck: the rail goes, the params go, the page is usable.
        await rail(page).getByRole("button", { name: "Close agent" }).click();
        await expect(rail(page)).toHaveCount(0);
        await expect.poll(() => new URL(page.url()).search).toBe("");
        await expect(page.getByRole("heading", { name: "OKRs", exact: true })).toBeVisible();
      }
    }
  } finally {
    await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = $1`, [conversationId]).catch(() => undefined);
    await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = $1`, [conversationId]).catch(() => undefined);
    await pool.end();
  }
});
