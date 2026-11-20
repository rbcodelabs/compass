import { randomUUID } from "node:crypto";
import pg from "pg";
import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";

const S = "compass_dev";

// A MENTION_ONLY thread adds the "@Compass Agent" quick-mention pill to the composer footer. At 390px that made the footer
// wider than the card, so Tools and the Model picker sat clipped / off-screen and could not be reached.
test("a mention-only Conversation panel keeps every composer toolbar button on-screen and clickable at 390px", async ({ page, base }) => {
  test.setTimeout(180_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const suffix = randomUUID().slice(0, 8);
  const oppId = randomUUID();
  const convId = randomUUID();
  try {
    const {
      rows: [ids],
    } = await pool.query<{ workspace_id: string; owner_id: string }>(
      `SELECT w.id AS workspace_id, (SELECT id FROM "${S}".users WHERE email = 'dev@localhost.dev') AS owner_id
         FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id
        WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace'`,
    );
    await pool.query(
      `INSERT INTO "${S}".opportunities (id, workspace_id, title, description, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'Composer layout fixture.', 'EXPLORING', NOW(), NOW())`,
      [oppId, ids.workspace_id, `Composer layout opportunity ${suffix}`],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, summary, target_type, target_id, visibility, status, agent_mode, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Composer layout fixture', 'OPPORTUNITY', $5, 'WORKSPACE', 'OPEN', 'MENTION_ONLY', 'BROWSER', NOW(), NOW())`,
      [convId, ids.workspace_id, ids.owner_id, `Composer layout thread ${suffix}`, oppId],
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/discovery?detail=conversation:${convId}`);
    await expect(page.getByTestId("agent-quick-mention-pill")).toBeVisible({ timeout: 30_000 });
    const footer = page.locator('[data-slot="composer-footer"]').last();
    const tools = footer.getByRole("button", { name: "Tools available in this session" });
    const model = footer.getByRole("button", { name: /^Model:/ });
    await expect(tools).toBeVisible();
    await expect(model).toBeVisible();

    // Every footer control is fully inside the viewport, and the card itself does not scroll horizontally.
    for (const control of await footer.getByRole("button").all()) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    const card = page.locator('[data-slot="composer-card"]').last();
    await expect.poll(() => card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    // Reachable: both open their menus.
    await tools.click();
    await expect(page.getByText("Compass (workspace tools)")).toBeVisible();
    await page.keyboard.press("Escape");
    await model.click();
    await expect(page.getByRole("listbox", { name: "Model" })).toBeVisible();
    await page.keyboard.press("Escape");
  } finally {
    await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = $1`, [convId]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = $1`, [convId]).catch(() => {});
    await pool.query(`DELETE FROM "${S}".opportunities WHERE id = $1`, [oppId]).catch(() => {});
    await pool.end();
  }
});
