import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import { E2E_ORG_SLUG, E2E_USER_EMAIL, E2E_WORKSPACE_SLUG } from "../fixtures/seed-e2e";

const S = "compass_dev";

// True when the element's centre is what a pointer would actually hit (not covered by another layer such as the Conversation panel).
const hitsItself = (el: Locator) =>
  el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!hit && node.contains(hit);
  });

// Opens a choice chip (it is a bottom sheet on a phone), proves an unselected option is painted on top and clickable, picks it,
// and observes the chip's name change.
async function pickAnotherOption(page: Page, chip: Locator, kind: string) {
  await chip.click();
  const option = page.getByRole("listbox", { name: kind }).locator('[role="option"][aria-selected="false"]').first();
  await expect(option).toBeVisible();
  expect(await hitsItself(option)).toBe(true);
  const label = (await option.getAttribute("aria-label"))!;
  await option.click();
  await expect(chip).toHaveAccessibleName(`${kind}: ${label}`);
  await expect(page.getByRole("listbox", { name: kind })).toHaveCount(0);
}

// A MENTION_ONLY thread adds the "@Compass Agent" quick-mention pill to the composer footer. At 390px that made the footer
// wider than the card, so Tools and the Model picker sat clipped / off-screen. Once on-screen, the chip menus (bottom sheets)
// must also paint above the Conversation panel (z-60) they are opened from.
for (const width of [390, 320]) {
  test(`a mention-only Conversation panel keeps every composer toolbar control on-screen, visible and usable at ${width}px`, async ({ page, base }) => {
    test.setTimeout(180_000);
    const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
    const suffix = randomUUID().slice(0, 8);
    const oppId = randomUUID();
    const convId = randomUUID();
    try {
      const {
        rows: [ids],
      } = await pool.query<{ workspace_id: string; owner_id: string }>(
        `SELECT w.id AS workspace_id, (SELECT id FROM "${S}".users WHERE email = $1) AS owner_id
           FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id
          WHERE o.slug = $2 AND w.slug = $3`,
        [E2E_USER_EMAIL, E2E_ORG_SLUG, E2E_WORKSPACE_SLUG],
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

      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${base}/discovery?detail=conversation:${convId}`);
      await expect(page.getByTestId("agent-quick-mention-pill")).toBeVisible({ timeout: 30_000 });
      const footer = page.locator('[data-slot="composer-footer"]').last();
      const tools = footer.getByRole("button", { name: "Tools available in this session" });
      const model = footer.getByRole("button", { name: /^Model:/ });
      const participation = footer.getByRole("button", { name: /^Participation:/ });
      await expect(tools).toBeVisible();
      await expect(model).toBeVisible();
      await expect(participation).toBeVisible();

      // Every footer control is fully inside the viewport, and the card itself does not scroll horizontally.
      for (const control of await footer.getByRole("button").all()) {
        const box = (await control.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      const card = page.locator('[data-slot="composer-card"]').last();
      await expect.poll(() => card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

      // Tools (a popover): its content is painted on top and hit-testable.
      await tools.click();
      const toolsRow = page.getByText("Compass (workspace tools)");
      await expect(toolsRow).toBeVisible();
      expect(await hitsItself(toolsRow)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(toolsRow).toHaveCount(0);

      // Model and Participation (bottom sheets): an option is visible, on top, clickable, and the pick lands.
      await pickAnotherOption(page, model, "Model");
      await pickAnotherOption(page, participation, "Participation");
    } finally {
      await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = $1`, [convId]).catch(() => {});
      await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = $1`, [convId]).catch(() => {});
      await pool.query(`DELETE FROM "${S}".opportunities WHERE id = $1`, [oppId]).catch(() => {});
      await pool.end();
    }
  });
}
