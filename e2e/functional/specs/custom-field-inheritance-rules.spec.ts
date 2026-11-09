/**
 * Custom field inheritance rules functional spec (TASK-101).
 *
 * Seeds an Opportunity SELECT field ("Customer"), a Roadmap item SELECT field ("Partner") and two roadmap items linked
 * to one opportunity directly into the functional harness database (same approach as discovery-field-board.spec.ts), so
 * this stays on the two flows that matter: managing rules in Settings, and a source value set AFTER the link.
 *
 * Journey:
 *   1. Settings → Custom Fields → Inheritance rules: add a rule (Partner <- Customer), see it Active, disable it, enable it,
 *      read the row back from the database each time.
 *   2. Link-then-fill: the opportunity has no Customer yet, so both linked roadmap items have an empty Partner. Drag the
 *      opportunity into "Acme" on the Discovery board (group by Customer): the item with an empty Partner is filled, the
 *      item whose Partner was set by hand is not overwritten.
 *   3. Drag the opportunity to "Globex": the filled target keeps "acme" (changing the source never rewrites a target).
 *      Drag it back to Unspecified: the target still keeps its value (clearing the source never clears a target).
 *   4. Delete the rule in Settings; the row is gone.
 *
 * Global teardown removes the fields, values and rows with the rest of the e2e workspace; the spec also cleans its own rule.
 */
import pg from "pg";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

const S = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";

function pool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for functional seeding");
  return new pg.Pool({ connectionString: process.env.DATABASE_URL });
}

type Seeded = {
  workspaceId: string;
  customerFieldId: string;
  partnerFieldId: string;
  customerName: string;
  partnerName: string;
  opportunity: { id: string; title: string };
  emptyItem: string;
  handSetItem: string;
};

async function seed(stamp: number): Promise<Seeded> {
  const db = pool();
  try {
    const { rows: [workspace] } = await db.query<{ id: string }>(`
      SELECT w.id FROM "${S}".workspaces w
      JOIN "${S}".organizations o ON o.id = w.organization_id
      WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace' LIMIT 1
    `);
    if (!workspace) throw new Error("E2E workspace has not been seeded");

    const options = JSON.stringify([
      { label: "Acme", value: "acme" },
      { label: "Globex", value: "globex" },
      { label: "Initech", value: "initech" },
    ]);
    const field = async (objectType: string, name: string) =>
      (await db.query<{ id: string }>(`
        INSERT INTO "${S}".custom_field_definitions (id, workspace_id, object_type, name, field_type, options, required, "order", created_at)
        VALUES (gen_random_uuid(), $1, $2, $3, 'SELECT', $4::jsonb, false, 0, NOW()) RETURNING id
      `, [workspace.id, objectType, name, options])).rows[0].id;
    const customerName = `E2E Customer ${stamp}`;
    const partnerName = `E2E Partner ${stamp}`;
    const customerFieldId = await field("OPPORTUNITY", customerName);
    const partnerFieldId = await field("ROADMAP_ITEM", partnerName);

    const title = `E2E Inheritance Opportunity ${stamp}`;
    const { rows: [opportunity] } = await db.query<{ id: string }>(`
      INSERT INTO "${S}".opportunities (id, workspace_id, title, status, sort_order, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, 'VALIDATING', 7, NOW(), NOW()) RETURNING id
    `, [workspace.id, title]);

    const item = async (itemTitle: string) =>
      (await db.query<{ id: string }>(`
        INSERT INTO "${S}".roadmap_items (id, workspace_id, title, horizon, status, sort_order, opportunity_id, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, 'LATER', 'ACTIVE', 50, $3, NOW(), NOW()) RETURNING id
      `, [workspace.id, itemTitle, opportunity.id])).rows[0].id;
    const emptyItem = await item(`E2E Inheritance Empty ${stamp}`);
    const handSetItem = await item(`E2E Inheritance Hand-set ${stamp}`);
    await db.query(`
      INSERT INTO "${S}".custom_field_values (id, field_id, object_id, value, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, '"initech"'::jsonb, NOW(), NOW())
    `, [partnerFieldId, handSetItem]);

    return { workspaceId: workspace.id, customerFieldId, partnerFieldId, customerName, partnerName, opportunity: { id: opportunity.id, title }, emptyItem, handSetItem };
  } finally {
    await db.end();
  }
}

async function value(fieldId: string, objectId: string): Promise<unknown> {
  const db = pool();
  try {
    const { rows } = await db.query<{ value: unknown }>(`SELECT value FROM "${S}".custom_field_values WHERE field_id = $1 AND object_id = $2`, [fieldId, objectId]);
    return rows[0]?.value ?? null;
  } finally {
    await db.end();
  }
}

async function rules(workspaceId: string, targetFieldId: string) {
  const db = pool();
  try {
    return (await db.query<{ enabled: boolean; priority: number; source_object_type: string }>(
      `SELECT enabled, priority, source_object_type FROM "${S}".custom_field_inheritance_rules WHERE workspace_id = $1 AND target_field_id = $2`,
      [workspaceId, targetFieldId],
    )).rows;
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


/**
 * Optional UI evidence: set INHERITANCE_SCREENSHOT_DIR (plus INHERITANCE_SCREENSHOT_LABEL, e.g. "commit abc1234 / 2026-11-08 / dev-builder
 * functional e2e") and the Settings states are captured at desktop and mobile widths, each with a label strip burned into the image.
 */
const SHOT_DIR = process.env.INHERITANCE_SCREENSHOT_DIR;
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

async function capture(page: Page, state: string) {
  if (!SHOT_DIR) return;
  const original = page.viewportSize();
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const panel = page.getByTestId("inheritance-rules");
    await panel.scrollIntoViewIfNeeded();
    await page.evaluate(
      ({ text }) => {
        document.getElementById("shot-label")?.remove();
        const strip = document.createElement("div");
        strip.id = "shot-label";
        strip.textContent = text;
        strip.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:4px 8px;font:11px monospace;background:#111;color:#fff";
        document.body.appendChild(strip);
      },
      { text: `${process.env.INHERITANCE_SCREENSHOT_LABEL ?? "local"} / ${viewport.name} ${viewport.width}x${viewport.height} / ${state}` },
    );
    await page.screenshot({ path: `${SHOT_DIR}/inheritance-rules-${state}-${viewport.name}.png`, fullPage: false });
    await page.evaluate(() => document.getElementById("shot-label")?.remove());
  }
  if (original) await page.setViewportSize(original);
}

const column = (page: Page, id: string) => page.locator(`[data-column-id="${id}"]`);
const card = (page: Page, title: string) => page.locator('[data-slot="card"]').filter({ hasText: title });

test.describe.serial("Custom field inheritance rules", () => {
  let seeded: Seeded;

  test.beforeAll(async () => {
    seeded = await seed(Date.now());
  });

  test("Settings: add, disable, enable a rule", async ({ page, base }) => {
    await page.goto(`${base}/settings`);
    const panel = page.getByTestId("inheritance-rules");
    await expect(panel.getByRole("heading", { name: "Inheritance rules" })).toBeVisible();

    await panel.getByTestId("inheritance-rule-add").click();
    await panel.getByLabel("Roadmap item field").click();
    await page.getByRole("option", { name: seeded.partnerName, exact: true }).click();
    await panel.getByLabel("Inherit from").click();
    await page.getByRole("option", { name: `${seeded.customerName} (opportunity)`, exact: true }).click();
    await capture(page, "1-create-rule-form");
    await panel.getByTestId("inheritance-rule-save").click();

    // Other specs may leave rules in the shared workspace: find this spec's row by its field names, never by position.
    const row = panel.getByRole("listitem").filter({ hasText: seeded.partnerName });
    await expect(row).toContainText(seeded.partnerName);
    await expect(row).toContainText(seeded.customerName);
    await expect(row.getByTestId(/^inheritance-rule-status-/)).toHaveText("Active");
    await expect.poll(() => rules(seeded.workspaceId, seeded.partnerFieldId)).toEqual([{ enabled: true, priority: 0, source_object_type: "OPPORTUNITY" }]);
    await capture(page, "2-rule-list-active");

    await row.getByRole("switch").click();
    await expect(row.getByTestId(/^inheritance-rule-status-/)).toHaveText("Disabled");
    await expect.poll(async () => (await rules(seeded.workspaceId, seeded.partnerFieldId))[0]?.enabled).toBe(false);
    await capture(page, "3-rule-disabled");

    await row.getByRole("switch").click();
    await expect(row.getByTestId(/^inheritance-rule-status-/)).toHaveText("Active");
    await expect.poll(async () => (await rules(seeded.workspaceId, seeded.partnerFieldId))[0]?.enabled).toBe(true);
  });

  test("link-then-fill: a source value set after the link fills empty targets only, and never rewrites or clears", async ({ page, base }) => {
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Group board by").click();
    await page.getByRole("option", { name: seeded.customerName, exact: true }).click();
    await expect(column(page, "unspecified").getByText(seeded.opportunity.title)).toBeVisible();

    // Before the source has a value, nothing was inherited.
    expect(await value(seeded.partnerFieldId, seeded.emptyItem)).toBeNull();

    const handle = () => card(page, seeded.opportunity.title).getByRole("button", { name: `Drag to change ${seeded.customerName}` });
    await dragTo(page, handle(), column(page, "option:acme"));
    await expect(column(page, "option:acme").getByText(seeded.opportunity.title)).toBeVisible();

    await expect.poll(() => value(seeded.partnerFieldId, seeded.emptyItem), { timeout: 10_000 }).toBe("acme");
    // The item whose Partner was set by hand keeps it.
    expect(await value(seeded.partnerFieldId, seeded.handSetItem)).toBe("initech");

    // Changing the source later does not rewrite a filled target.
    await dragTo(page, handle(), column(page, "option:globex"));
    await expect(column(page, "option:globex").getByText(seeded.opportunity.title)).toBeVisible();
    await expect.poll(() => value(seeded.customerFieldId, seeded.opportunity.id)).toBe("globex");
    expect(await value(seeded.partnerFieldId, seeded.emptyItem)).toBe("acme");

    // Clearing the source does not clear the target.
    await dragTo(page, handle(), column(page, "unspecified"));
    await expect(column(page, "unspecified").getByText(seeded.opportunity.title)).toBeVisible();
    await expect.poll(() => value(seeded.customerFieldId, seeded.opportunity.id)).toBeNull();
    expect(await value(seeded.partnerFieldId, seeded.emptyItem)).toBe("acme");
    expect(await value(seeded.partnerFieldId, seeded.handSetItem)).toBe("initech");
  });

  test("Settings: delete the rule", async ({ page, base }) => {
    await page.goto(`${base}/settings`);
    const panel = page.getByTestId("inheritance-rules");
    await panel.getByRole("button", { name: `Delete rule ${seeded.partnerName} from ${seeded.customerName}` }).click();
    await expect(panel.getByText(seeded.partnerName)).toHaveCount(0);
    await expect.poll(() => rules(seeded.workspaceId, seeded.partnerFieldId)).toEqual([]);
  });
});
