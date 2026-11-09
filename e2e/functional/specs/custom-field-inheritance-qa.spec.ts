/**
 * Independent QA journeys for custom field inheritance rules (TASK-101), real browser interaction.
 *
 *  1. Unavailable state: the rules table is dropped in the job database (this spec runs first so the server has not yet
 *     cached a positive "table exists"), Settings must explain itself, then the table is recreated.
 *  2. Settings journey: incompatible sources are not offered, create three rules for one target, arrows at the ends,
 *     reorder, keyboard operation, stale-tab duplicate, options drift -> inactive, deleting a source field and then the
 *     target field removes the rules, layout at desktop and mobile.
 *  3. Link-then-fill through the roadmap detail panel (the UI's real link editor). Marked test.fail(): the panel saves
 *     the link through updateEntityField, which does not call applyInheritanceRules (QA defect). Remove test.fail() once fixed.
 *  4. Console / page errors / Next dev overlay text on /settings compared with other pages.
 *
 * Screenshots: test-results/qa-shots/*.png (desktop 1280x900, mobile 390x844), each with a label strip.
 */
import fs from "node:fs";
import pg from "pg";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

const S = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";
const SHOTS = "test-results/qa-shots";
const LABEL = process.env.INHERITANCE_SCREENSHOT_LABEL ?? "local";

function pool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for functional seeding");
  return new pg.Pool({ connectionString: process.env.DATABASE_URL });
}

async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const db = pool();
  try {
    return (await db.query<T>(text, params)).rows;
  } finally {
    await db.end();
  }
}

async function workspaceId() {
  const [row] = await sql<{ id: string }>(`SELECT w.id FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace' LIMIT 1`);
  if (!row) throw new Error("E2E workspace has not been seeded");
  return row.id;
}

const opts = (...values: string[]) => JSON.stringify(values.map((value) => ({ label: value.toUpperCase(), value })));

async function field(ws: string, objectType: string, name: string, fieldType: string, options: string | null) {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO "${S}".custom_field_definitions (id, workspace_id, object_type, name, field_type, options, required, "order", created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, false, 0, NOW()) RETURNING id`,
    [ws, objectType, name, fieldType, options],
  );
  return row.id;
}

const rulesFor = (targetFieldId: string) =>
  sql<{ source_field_id: string; priority: number; enabled: boolean }>(
    `SELECT source_field_id, priority, enabled FROM "${S}".custom_field_inheritance_rules WHERE target_field_id = $1 ORDER BY priority`,
    [targetFieldId],
  );

async function shot(page: Page, state: string, viewports: { name: string; width: number; height: number }[] = DESKTOP_AND_MOBILE) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const original = page.viewportSize();
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.getByTestId("inheritance-rules").scrollIntoViewIfNeeded();
    await page.evaluate((text) => {
      document.getElementById("qa-label")?.remove();
      const strip = document.createElement("div");
      strip.id = "qa-label";
      strip.textContent = text;
      strip.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:4px 8px;font:11px monospace;background:#111;color:#fff";
      document.body.appendChild(strip);
    }, `${LABEL} / QA / ${viewport.name} ${viewport.width}x${viewport.height} / ${state}`);
    await page.screenshot({ path: `${SHOTS}/${state}-${viewport.name}.png` });
    await page.evaluate(() => document.getElementById("qa-label")?.remove());
  }
  if (original) await page.setViewportSize(original);
}
const DESKTOP_AND_MOBILE = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

/** Every control inside the panel must sit inside the viewport and no row may clip its own content. */
async function expectNoClipping(page: Page, label: string) {
  for (const viewport of DESKTOP_AND_MOBILE) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const panel = page.getByTestId("inheritance-rules");
    await panel.scrollIntoViewIfNeeded();
    const report = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="inheritance-rules"]')!;
      const vw = window.innerWidth;
      const out: string[] = [];
      for (const el of root.querySelectorAll('button, [role="switch"], [role="combobox"], select')) {
        const box = el.getBoundingClientRect();
        if (box.width === 0) continue;
        if (box.left < -0.5 || box.right > vw + 0.5) out.push(`control off-screen: ${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)} [${Math.round(box.left)}..${Math.round(box.right)}] of ${vw}`);
        if (box.width < 16 || box.height < 16) out.push(`control tiny: ${(el.getAttribute("aria-label") ?? "").slice(0, 40)} ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
      for (const li of root.querySelectorAll("li")) if (li.scrollWidth > li.clientWidth + 1) out.push(`row clipped: scrollWidth ${li.scrollWidth} > ${li.clientWidth}`);
      const rootBox = root.getBoundingClientRect();
      if (rootBox.right > vw + 0.5) out.push(`panel wider than viewport: ${Math.round(rootBox.right)} > ${vw}`);
      return { problems: out, pageOverflow: document.documentElement.scrollWidth - vw };
    });
    expect.soft(report.problems, `${label} @ ${viewport.name}`).toEqual([]);
    expect.soft(report.pageOverflow, `${label} @ ${viewport.name}: document horizontal overflow (px)`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.describe.serial("Inheritance rules QA", () => {
  test.setTimeout(180_000);
  let ws: string;

  test.beforeAll(async () => {
    ws = await workspaceId();
  });

  test("1. unavailable state when the rules table does not exist, and recovery when it appears", async ({ page, base }) => {
    await sql(`DROP TABLE IF EXISTS "${S}".custom_field_inheritance_rules`);
    try {
      await page.goto(`${base}/settings`);
      const panel = page.getByTestId("inheritance-rules");
      await expect(panel.getByRole("heading", { name: "Inheritance rules" })).toBeVisible({ timeout: 90_000 });
      await expect(panel.getByTestId("inheritance-rules-unavailable")).toBeVisible();
      await expect(panel.getByTestId("inheritance-rule-add")).toHaveCount(0);
      await expect(panel.getByText("No inheritance rules yet.")).toHaveCount(0);
      await shot(page, "unavailable-table-missing");
      await expectNoClipping(page, "unavailable");
    } finally {
      await sql(`
        CREATE TABLE IF NOT EXISTS "${S}".custom_field_inheritance_rules (
          id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, workspace_id UUID NOT NULL, target_object_type VARCHAR(50) NOT NULL,
          target_field_id UUID NOT NULL, source_object_type VARCHAR(50) NOT NULL, source_field_id UUID NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
          enabled BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_by_id UUID, updated_by_id UUID, source VARCHAR(20) NOT NULL DEFAULT 'UI')`);
      await sql(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cfir_target_priority ON "${S}".custom_field_inheritance_rules (workspace_id, target_field_id, priority)`);
      await sql(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cfir_target_source ON "${S}".custom_field_inheritance_rules (workspace_id, target_field_id, source_field_id)`);
      await sql(`CREATE INDEX IF NOT EXISTS idx_cfir_workspace_target_type ON "${S}".custom_field_inheritance_rules (workspace_id, target_object_type)`);
    }
    // The negative answer is never cached, so the page recovers on the next request without a restart.
    await page.goto(`${base}/settings`);
    await expect(page.getByTestId("inheritance-rules").getByTestId("inheritance-rules-unavailable")).toHaveCount(0);
  });

  test("2. Settings journey: picker compatibility, three rules, reorder, keyboard, stale duplicate, drift, field deletion, layout", async ({ page, base, context }) => {
    const stamp = Date.now();
    const n = (label: string) => `QA ${label} ${stamp}`;
    const target = await field(ws, "ROADMAP_ITEM", n("Target"), "SELECT", opts("a", "b", "c"));
    const numTarget = await field(ws, "ROADMAP_ITEM", n("NumTarget"), "NUMBER", null);
    const oppOk = await field(ws, "OPPORTUNITY", n("OppOk"), "SELECT", opts("a", "b"));
    const solOk = await field(ws, "SOLUTION", n("SolOk"), "SELECT", opts("a", "b", "c"));
    const sol2 = await field(ws, "SOLUTION", n("Sol2"), "SELECT", opts("a"));
    const oppTooMany = await field(ws, "OPPORTUNITY", n("OppTooMany"), "SELECT", opts("a", "b", "c", "d"));
    const oppText = await field(ws, "OPPORTUNITY", n("OppText"), "TEXT", null);
    const nameOf = (suffix: string) => n(suffix);

    await page.goto(`${base}/settings`);
    const panel = page.getByTestId("inheritance-rules");
    await expect(panel.getByRole("heading", { name: "Inheritance rules" })).toBeVisible({ timeout: 60_000 });
    const row = (source: string) => panel.getByRole("listitem").filter({ hasText: nameOf(source) }).filter({ hasText: nameOf("Target") });
    const priorityOrder = async () => (await rulesFor(target)).map((rule) => rule.source_field_id);

    // a. A target with no compatible source says so and offers nothing.
    await panel.getByTestId("inheritance-rule-add").click();
    await panel.getByLabel("Roadmap item field").click();
    await page.getByRole("option", { name: nameOf("NumTarget"), exact: true }).click();
    await expect(panel.getByText(/No opportunity or solution field has the same type/)).toBeVisible();
    await panel.getByLabel("Inherit from").click();
    expect(await page.getByRole("option").count()).toBe(0);
    await page.keyboard.press("Escape");
    await shot(page, "form-no-compatible-source");

    // b. Only compatible sources are offered for the pick-list target.
    await panel.getByLabel("Roadmap item field").click();
    await page.getByRole("option", { name: nameOf("Target"), exact: true }).click();
    await panel.getByLabel("Inherit from").click();
    const offered = (await page.getByRole("option").allTextContents()).map((text) => text.trim());
    await shot(page, "form-source-picker-open");
    expect(offered.some((text) => text.startsWith(nameOf("OppOk")))).toBe(true);
    expect(offered.some((text) => text.startsWith(nameOf("SolOk")))).toBe(true);
    expect(offered.some((text) => text.startsWith(nameOf("Sol2")))).toBe(true);
    expect(offered.some((text) => text.startsWith(nameOf("OppTooMany"))), "options-superset source must not be offered").toBe(false);
    expect(offered.some((text) => text.startsWith(nameOf("OppText"))), "type-mismatch source must not be offered").toBe(false);
    await page.keyboard.press("Escape");

    // c. Create three rules for one target; the picker never re-offers a used source (so a UI duplicate is impossible).
    for (const source of ["OppOk", "SolOk", "Sol2"]) {
      if (!(await panel.getByTestId("inheritance-rule-form").isVisible())) await panel.getByTestId("inheritance-rule-add").click();
      await panel.getByLabel("Roadmap item field").click();
      await page.getByRole("option", { name: nameOf("Target"), exact: true }).click();
      await panel.getByLabel("Inherit from").click();
      await page.getByRole("option", { name: new RegExp(`^${nameOf(source)}`) }).click();
      await panel.getByTestId("inheritance-rule-save").click();
      await expect(row(source)).toBeVisible();
    }
    expect((await rulesFor(target)).map((rule) => rule.priority)).toEqual([0, 1, 2]);
    expect(await priorityOrder()).toEqual([oppOk, solOk, sol2]);
    await panel.getByTestId("inheritance-rule-add").click();
    await panel.getByLabel("Roadmap item field").click();
    await page.getByRole("option", { name: nameOf("Target"), exact: true }).click();
    await panel.getByLabel("Inherit from").click();
    expect(await page.getByRole("option").count(), "all compatible sources are used up").toBe(0);
    await page.keyboard.press("Escape");
    await panel.getByRole("button", { name: "Cancel" }).click();
    await shot(page, "three-rules");
    await expectNoClipping(page, "three rules");

    // d. Priority badges and arrow enablement at the ends.
    const badges = await Promise.all(["OppOk", "SolOk", "Sol2"].map((source) => row(source).locator('span[title^="Priority"]').textContent()));
    expect(badges.map((text) => text?.trim())).toEqual(["1", "2", "3"]);
    await expect(row("OppOk").getByRole("button", { name: "Raise priority" })).toBeDisabled();
    await expect(row("OppOk").getByRole("button", { name: "Lower priority" })).toBeEnabled();
    await expect(row("SolOk").getByRole("button", { name: "Raise priority" })).toBeEnabled();
    await expect(row("SolOk").getByRole("button", { name: "Lower priority" })).toBeEnabled();
    await expect(row("Sol2").getByRole("button", { name: "Lower priority" })).toBeDisabled();

    // e. Accessible names: record duplicates (several rows expose identical names for different rules).
    const names = await panel.getByRole("listitem").locator("button, [role=switch]").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? ""));
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    console.log(`A11Y duplicate accessible names within the rule list: ${JSON.stringify([...new Set(duplicates)])} (of ${names.length} controls)`);
    test.info().annotations.push({ type: "a11y-duplicate-names", description: JSON.stringify([...new Set(duplicates)]) });

    // f. Reorder with the mouse: lower the first rule; then raise the last one two steps.
    await row("OppOk").getByRole("button", { name: "Lower priority" }).click();
    await expect.poll(priorityOrder).toEqual([solOk, oppOk, sol2]);
    await expect(row("OppOk").getByRole("button", { name: "Lower priority" })).toBeEnabled();
    await row("Sol2").getByRole("button", { name: "Raise priority" }).click();
    await expect.poll(priorityOrder).toEqual([solOk, sol2, oppOk]);
    await row("Sol2").getByRole("button", { name: "Raise priority" }).click();
    await expect.poll(priorityOrder).toEqual([sol2, solOk, oppOk]);
    expect((await rulesFor(target)).map((rule) => rule.priority)).toEqual([0, 1, 2]);
    await expect(row("Sol2").getByRole("button", { name: "Raise priority" })).toBeDisabled();
    // The rendered order follows the DB order.
    const texts = await panel.getByRole("listitem").filter({ hasText: nameOf("Target") }).allTextContents();
    expect(texts.findIndex((t) => t.includes(nameOf("Sol2")))).toBeLessThan(texts.findIndex((t) => t.includes(nameOf("SolOk"))));
    await shot(page, "after-reorder");

    // g. Keyboard: Space on the focused switch disables, Space again enables; Enter on the arrow button moves the rule.
    const sw = row("SolOk").getByRole("switch");
    await sw.focus();
    await page.keyboard.press("Space");
    await expect(row("SolOk").getByTestId(/inheritance-rule-status-/)).toHaveText("Disabled");
    await expect.poll(async () => (await rulesFor(target)).find((rule) => rule.source_field_id === solOk)?.enabled).toBe(false);
    await shot(page, "keyboard-disabled");
    await sw.focus();
    await page.keyboard.press("Space");
    await expect(row("SolOk").getByTestId(/inheritance-rule-status-/)).toHaveText("Active");
    // Enter on a switch: record, do not assert (not required by the switch pattern).
    await sw.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    console.log(`KEYBOARD Enter on switch toggled it: ${(await row("SolOk").getByTestId(/inheritance-rule-status-/).textContent())?.trim() === "Disabled"}`);
    if ((await row("SolOk").getByTestId(/inheritance-rule-status-/).textContent())?.trim() === "Disabled") {
      await sw.focus();
      await page.keyboard.press("Space");
      await expect(row("SolOk").getByTestId(/inheritance-rule-status-/)).toHaveText("Active");
    }
    // Tab order inside a row: switch -> raise -> lower -> delete.
    await sw.focus();
    await page.keyboard.press("Tab");
    await expect(row("SolOk").getByRole("button", { name: "Raise priority" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(priorityOrder).toEqual([solOk, sol2, oppOk]);

    // h. Stale tab: another tab already created the rule this tab is about to create -> friendly error, no crash.
    await row("OppOk").getByRole("button", { name: `Delete rule for ${nameOf("Target")}` }).click();
    await expect(row("OppOk")).toHaveCount(0);
    expect((await rulesFor(target)).map((rule) => rule.priority)).toEqual([0, 1]);
    await panel.getByTestId("inheritance-rule-add").click();
    await panel.getByLabel("Roadmap item field").click();
    await page.getByRole("option", { name: nameOf("Target"), exact: true }).click();
    await panel.getByLabel("Inherit from").click();
    await page.getByRole("option", { name: new RegExp(`^${nameOf("OppOk")}`) }).click();
    const other = await context.newPage();
    await other.goto(`${base}/settings`);
    const otherPanel = other.getByTestId("inheritance-rules");
    await otherPanel.getByTestId("inheritance-rule-add").click();
    await otherPanel.getByLabel("Roadmap item field").click();
    await other.getByRole("option", { name: nameOf("Target"), exact: true }).click();
    await otherPanel.getByLabel("Inherit from").click();
    await other.getByRole("option", { name: new RegExp(`^${nameOf("OppOk")}`) }).click();
    await otherPanel.getByTestId("inheritance-rule-save").click();
    await expect(otherPanel.getByRole("listitem").filter({ hasText: nameOf("OppOk") })).toBeVisible();
    await other.close();
    await panel.getByTestId("inheritance-rule-save").click();
    await expect(panel.getByTestId("inheritance-rules-error")).toContainText(/already exists|priority is taken/i);
    await shot(page, "stale-duplicate-error");
    expect((await rulesFor(target)).map((rule) => rule.source_field_id).filter((id) => id === oppOk)).toHaveLength(1);
    await panel.getByRole("button", { name: "Cancel" }).click();

    // i. Options drift: remove option "c" from the target in the database -> the SolOk rule (covers c) becomes inactive.
    await sql(`UPDATE "${S}".custom_field_definitions SET options = $2::jsonb WHERE id = $1`, [target, opts("a", "b")]);
    await page.reload();
    await expect(row("SolOk").getByTestId(/inheritance-rule-status-/)).toContainText(/Inactive: Options mismatch/);
    await expect(row("OppOk").getByTestId(/inheritance-rule-status-/)).toHaveText("Active");
    await shot(page, "inactive-options-mismatch");
    await expectNoClipping(page, "inactive row");
    await sql(`UPDATE "${S}".custom_field_definitions SET options = $2::jsonb WHERE id = $1`, [target, opts("a", "b", "c")]);

    // j. Delete a SOURCE custom field in the fields manager: its rule disappears from the list and the table.
    await page.reload();
    await expect(row("Sol2")).toBeVisible();
    await page.getByRole("button", { name: `Delete ${nameOf("Sol2")}`, exact: true }).click();
    await expect(row("Sol2")).toHaveCount(0, { timeout: 15_000 });
    expect((await rulesFor(target)).map((rule) => rule.source_field_id)).not.toContain(sol2);
    expect((await rulesFor(target)).map((rule) => rule.priority), "a gap is left after deleting the middle rule").toEqual([0, 2]);
    // Reordering across the gap still works.
    await row("OppOk").getByRole("button", { name: "Raise priority" }).click();
    await expect.poll(priorityOrder).toEqual([oppOk, solOk]);

    // k. Delete the TARGET field: every remaining rule for it is removed, and none dangle in the table.
    await page.getByRole("button", { name: `Delete ${nameOf("Target")}`, exact: true }).click();
    await expect(panel.getByRole("listitem").filter({ hasText: nameOf("Target") })).toHaveCount(0, { timeout: 15_000 });
    expect(await rulesFor(target)).toEqual([]);
    const dangling = await sql(`SELECT 1 FROM "${S}".custom_field_inheritance_rules r WHERE r.workspace_id = $1 AND (NOT EXISTS (SELECT 1 FROM "${S}".custom_field_definitions d WHERE d.id = r.target_field_id) OR NOT EXISTS (SELECT 1 FROM "${S}".custom_field_definitions d WHERE d.id = r.source_field_id))`, [ws]);
    expect(dangling, "no rule may reference a deleted field").toEqual([]);

    // cleanup
    for (const id of [numTarget, oppOk, solOk, oppTooMany, oppText]) await sql(`DELETE FROM "${S}".custom_field_definitions WHERE id = $1`, [id]);
  });

  test("3. DEFECT: linking an opportunity in the roadmap detail panel does not fill the inherited field", async ({ page, base }) => {
    test.fail(true, "updateEntityField (panel PATCH) sets roadmap opportunityId without applyInheritanceRules; editRoadmapItem has no callers");
    const stamp = Date.now();
    const customer = await field(ws, "OPPORTUNITY", `QA Customer ${stamp}`, "SELECT", opts("acme", "globex"));
    const partner = await field(ws, "ROADMAP_ITEM", `QA Partner ${stamp}`, "SELECT", opts("acme", "globex"));
    const [opportunity] = await sql<{ id: string }>(`INSERT INTO "${S}".opportunities (id, workspace_id, title, status, sort_order, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, 'VALIDATING', 8, NOW(), NOW()) RETURNING id`, [ws, `QA Link Opportunity ${stamp}`]);
    await sql(`INSERT INTO "${S}".custom_field_values (id, field_id, object_id, value, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, '"acme"'::jsonb, NOW(), NOW())`, [customer, opportunity.id]);
    await sql(`INSERT INTO "${S}".custom_field_inheritance_rules (workspace_id, target_object_type, target_field_id, source_object_type, source_field_id, priority, enabled, source) VALUES ($1,'ROADMAP_ITEM',$2,'OPPORTUNITY',$3,0,true,'UI')`, [ws, partner, customer]);
    const title = `QA Unlinked Item ${stamp}`;
    const [item] = await sql<{ id: string }>(`INSERT INTO "${S}".roadmap_items (id, workspace_id, title, horizon, status, sort_order, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, 'LATER', 'ACTIVE', 60, NOW(), NOW()) RETURNING id`, [ws, title]);
    const partnerValue = async () => (await sql<{ value: unknown }>(`SELECT value FROM "${S}".custom_field_values WHERE field_id = $1 AND object_id = $2`, [partner, item.id]))[0]?.value ?? null;

    await page.goto(`${base}/roadmap`);
    await page.waitForLoadState("networkidle");
    const card = page.locator('[data-slot="card"]').filter({ hasText: title });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.hover();
    await card.getByLabel("Card actions").click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const dialog = page.locator('[data-slot="sheet-content"]');
    const more = dialog.getByRole("button", { name: "More properties" });
    if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
    await dialog.getByRole("combobox", { name: "Opportunity" }).click();
    await page.getByRole("option", { name: `QA Link Opportunity ${stamp}` }).click();
    await expect(card.getByText(`QA Link Opportunity ${stamp}`, { exact: true })).toBeVisible({ timeout: 10_000 });
    expect((await sql<{ opportunity_id: string }>(`SELECT opportunity_id FROM "${S}".roadmap_items WHERE id = $1`, [item.id]))[0].opportunity_id).toBe(opportunity.id);

    // The link is saved; the inherited field should now be filled in the same request.
    await expect.poll(partnerValue, { timeout: 8_000 }).toBe("acme");
  });

  test("4. console errors, page errors and the Next dev overlay: /settings vs other pages", async ({ page, base }, testInfo) => {
    const results: Record<string, unknown> = {};
    for (const path of ["/roadmap", "/discovery", "/settings"]) {
      const messages: string[] = [];
      const onConsole = (message: import("@playwright/test").ConsoleMessage) => {
        if (["error", "warning"].includes(message.type())) messages.push(`${message.type()}: ${message.text().slice(0, 300)}`);
      };
      const onError = (error: Error) => messages.push(`pageerror: ${error.message.slice(0, 300)}`);
      page.on("console", onConsole);
      page.on("pageerror", onError);
      await page.goto(`${base}${path}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(2500);
      const overlay = await page.evaluate(() => {
        const portal = document.querySelector("nextjs-portal");
        const text = portal?.shadowRoot?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const badge = portal?.shadowRoot?.querySelector("[data-issues-count], [data-nextjs-dev-tools-button], [data-next-badge]");
        return { portal: Boolean(portal), text: text.slice(0, 600), badge: badge?.textContent?.trim() ?? null };
      });
      page.off("console", onConsole);
      page.off("pageerror", onError);
      results[path] = { messages, overlay };
    }
    console.log(`CONSOLE_REPORT ${JSON.stringify(results, null, 2)}`);
    await testInfo.attach("console-report.json", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
  });
});
