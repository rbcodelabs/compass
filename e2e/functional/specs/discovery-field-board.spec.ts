/**
 * Discovery "Group by: <custom field>" card-sort functional spec.
 *
 * Seeds an Opportunity SELECT field (MoSCoW-style) and opportunities directly
 * into the functional harness database — same approach as
 * roadmap-sidebar-delivery-tasks.spec.ts — so this stays focused on the board
 * rather than on Settings UI coverage. Global teardown removes the field,
 * its values and the opportunities with the rest of the e2e workspace.
 *
 * Journey:
 *   1. Choose the field from the Group by picker; Unspecified comes first and
 *      holds both the untagged and the stale-valued opportunity.
 *   2. Drag an Unspecified card into "Should"; after reload it is still there,
 *      the stored value is "should", and status/sortOrder are unchanged.
 *   3. Drag it back to Unspecified; the stored value row is gone.
 *   4. A stale field id in the URL falls back to the Status board.
 */
import pg from "pg";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

const S = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";

function pool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for functional seeding");
  return new pg.Pool({ connectionString: process.env.DATABASE_URL });
}

type Seeded = { fieldId: string; fieldName: string; untagged: { id: string; title: string }; stale: string; tagged: string };

async function seed(): Promise<Seeded> {
  const db = pool();
  const stamp = Date.now();
  try {
    const { rows: [workspace] } = await db.query<{ id: string }>(`
      SELECT w.id FROM "${S}".workspaces w
      JOIN "${S}".organizations o ON o.id = w.organization_id
      WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace' LIMIT 1
    `);
    if (!workspace) throw new Error("E2E workspace has not been seeded");

    const fieldName = `MoSCoW ${stamp}`;
    const { rows: [field] } = await db.query<{ id: string }>(`
      INSERT INTO "${S}".custom_field_definitions
        (id, workspace_id, object_type, name, field_type, options, required, "order", created_at)
      VALUES (gen_random_uuid(), $1, 'OPPORTUNITY', $2, 'SELECT', $3::jsonb, false, 0, NOW())
      RETURNING id
    `, [workspace.id, fieldName, JSON.stringify([
      { label: "Must", value: "must", color: "#dc2626" },
      { label: "Should", value: "should" },
    ])]);

    async function opportunity(title: string, value?: string) {
      const { rows: [row] } = await db.query<{ id: string }>(`
        INSERT INTO "${S}".opportunities (id, workspace_id, title, status, sort_order, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, 'VALIDATING', 7, NOW(), NOW()) RETURNING id
      `, [workspace.id, title]);
      if (value !== undefined) {
        await db.query(`
          INSERT INTO "${S}".custom_field_values (id, field_id, object_id, value, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, $2, $3::jsonb, NOW(), NOW())
        `, [field.id, row.id, JSON.stringify(value)]);
      }
      return { id: row.id, title };
    }

    const untagged = await opportunity(`E2E Card Sort Untagged ${stamp}`);
    const stale = await opportunity(`E2E Card Sort Stale ${stamp}`, "removed-option");
    const tagged = await opportunity(`E2E Card Sort Must ${stamp}`, "must");
    return { fieldId: field.id, fieldName, untagged, stale: stale.title, tagged: tagged.title };
  } finally {
    await db.end();
  }
}

async function readBack(fieldId: string, opportunityId: string) {
  const db = pool();
  try {
    const { rows: values } = await db.query<{ value: unknown }>(
      `SELECT value FROM "${S}".custom_field_values WHERE field_id = $1 AND object_id = $2`,
      [fieldId, opportunityId],
    );
    const { rows: [opportunity] } = await db.query<{ status: string; sort_order: number }>(
      `SELECT status, sort_order FROM "${S}".opportunities WHERE id = $1`,
      [opportunityId],
    );
    return { value: values[0]?.value ?? null, rows: values.length, ...opportunity };
  } finally {
    await db.end();
  }
}

/** dnd-kit's PointerSensor needs stepped movement past its 8px threshold. */
async function dragTo(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  if (!from) throw new Error("drag source has no bounding box");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 15, from.y + from.height / 2 + 15, { steps: 10 });
  await target.scrollIntoViewIfNeeded();
  const to = await target.boundingBox();
  if (!to) throw new Error("drag target has no bounding box");
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await page.mouse.up();
}

const column = (page: Page, id: string) => page.locator(`[data-column-id="${id}"]`);
const card = (page: Page, title: string) => page.locator('[data-slot="card"]').filter({ hasText: title });

test.describe("Discovery board grouped by a custom field", () => {
  test("sorts opportunities into field options and back to Unspecified", async ({ page, base }) => {
    const seeded = await seed();

    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Group board by").click();
    await page.getByRole("option", { name: seeded.fieldName, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`groupBy=field%3A${seeded.fieldId}|groupBy=field:${seeded.fieldId}`));

    await expect(page.getByText(`Drag between columns to change ${seeded.fieldName}. Return to Unspecified to clear it.`)).toBeVisible();
    await expect(page.locator("[data-column-id]")).toHaveCount(3);
    await expect(page.locator("[data-column-id]").first()).toHaveAttribute("data-column-id", "unspecified");
    await expect(column(page, "unspecified").getByText(seeded.untagged.title)).toBeVisible();
    await expect(column(page, "unspecified").getByText(seeded.stale)).toBeVisible();
    await expect(column(page, "option:must").getByText(seeded.tagged)).toBeVisible();
    await expect(page.getByRole("button", { name: /Add opportunity/i })).toHaveCount(0);

    // ── Unspecified → Should ──────────────────────────────────────────────
    await dragTo(
      page,
      card(page, seeded.untagged.title).getByRole("button", { name: `Drag to change ${seeded.fieldName}` }),
      column(page, "option:should"),
    );
    await expect(column(page, "option:should").getByText(seeded.untagged.title)).toBeVisible();
    await expect.poll(async () => (await readBack(seeded.fieldId, seeded.untagged.id)).value, { timeout: 10_000 }).toBe("should");

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(column(page, "option:should").getByText(seeded.untagged.title)).toBeVisible();
    const afterSet = await readBack(seeded.fieldId, seeded.untagged.id);
    expect(afterSet).toMatchObject({ status: "VALIDATING", sort_order: 7 });

    // ── Should → Unspecified clears the value ─────────────────────────────
    await dragTo(
      page,
      card(page, seeded.untagged.title).getByRole("button", { name: `Drag to change ${seeded.fieldName}` }),
      column(page, "unspecified"),
    );
    await expect(column(page, "unspecified").getByText(seeded.untagged.title)).toBeVisible();
    await expect.poll(async () => (await readBack(seeded.fieldId, seeded.untagged.id)).rows, { timeout: 10_000 }).toBe(0);
    const afterClear = await readBack(seeded.fieldId, seeded.untagged.id);
    expect(afterClear).toMatchObject({ status: "VALIDATING", sort_order: 7 });

    // ── A stale field id falls back to the Status board ───────────────────
    await page.goto(`${base}/discovery?groupBy=field:00000000-0000-0000-0000-000000000000`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByLabel("Group board by")).toContainText("Status");
    await expect(page.getByRole("region", { name: "Opportunity board" })).toBeVisible();
  });
});
