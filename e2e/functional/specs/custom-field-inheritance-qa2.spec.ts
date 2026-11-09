/**
 * Second independent QA pass for custom field inheritance (TASK-101), real browser + real Postgres.
 *  A. Rule rows: unique accessible names, inactive rule renders its switch off and disabled, wrapping/clipping at desktop and mobile.
 *  B. Panel link journeys: link fills an empty target; hand-set target kept; re-link to another opportunity never rewrites; unlink does nothing.
 *  C. Late-source window against real SQL: 501 active + archived linked items, two writes, progress past the 500 cap, archived untouched.
 *  D. Next dev overlay / console on /settings vs /settings/modules vs /roadmap.
 * Screenshots: test-results/qa2-shots/*.png, each with a label strip (commit, date, environment, viewport).
 */
import fs from "node:fs";
import pg from "pg";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

const S = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";
const SHOTS = "test-results/qa2-shots";
const LABEL = process.env.INHERITANCE_SCREENSHOT_LABEL ?? "local";
const VIEWPORTS = [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }];

async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try { return (await db.query<T>(text, params)).rows; } finally { await db.end(); }
}
const opts = (...values: string[]) => JSON.stringify(values.map((value) => ({ label: value.toUpperCase(), value })));
async function workspaceId() {
  const [row] = await sql<{ id: string }>(`SELECT w.id FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace' LIMIT 1`);
  return row.id;
}
async function field(ws: string, objectType: string, name: string, fieldType: string, options: string | null) {
  return (await sql<{ id: string }>(`INSERT INTO "${S}".custom_field_definitions (id, workspace_id, object_type, name, field_type, options, required, "order", created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, false, 0, NOW()) RETURNING id`, [ws, objectType, name, fieldType, options]))[0].id;
}
const rule = (ws: string, target: string, source: string, sourceType: string, priority: number, enabled = true) =>
  sql(`INSERT INTO "${S}".custom_field_inheritance_rules (workspace_id, target_object_type, target_field_id, source_object_type, source_field_id, priority, enabled, source) VALUES ($1,'ROADMAP_ITEM',$2,$4,$3,$5,$6,'UI')`, [ws, target, source, sourceType, priority, enabled]);
const opportunity = async (ws: string, title: string) =>
  (await sql<{ id: string }>(`INSERT INTO "${S}".opportunities (id, workspace_id, title, status, sort_order, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, 'VALIDATING', 9, NOW(), NOW()) RETURNING id`, [ws, title]))[0].id;
const setValue = (fieldId: string, objectId: string, value: string) =>
  sql(`INSERT INTO "${S}".custom_field_values (id, field_id, object_id, value, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3::jsonb, NOW(), NOW())`, [fieldId, objectId, JSON.stringify(value)]);
const getValue = async (fieldId: string, objectId: string) => (await sql<{ value: unknown }>(`SELECT value FROM "${S}".custom_field_values WHERE field_id = $1 AND object_id = $2`, [fieldId, objectId]))[0]?.value ?? null;
const item = async (ws: string, title: string, status = "ACTIVE") =>
  (await sql<{ id: string }>(`INSERT INTO "${S}".roadmap_items (id, workspace_id, title, horizon, status, sort_order, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, 'LATER', $3, 61, NOW(), NOW()) RETURNING id`, [ws, title, status]))[0].id;

async function shot(page: Page, state: string, locator?: Locator) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const original = page.viewportSize();
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await (locator ?? page.getByTestId("inheritance-rules")).scrollIntoViewIfNeeded();
    await page.evaluate((text) => {
      document.getElementById("qa-label")?.remove();
      const strip = document.createElement("div");
      strip.id = "qa-label"; strip.textContent = text;
      strip.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:99999;padding:4px 8px;font:11px monospace;background:#111;color:#fff";
      document.body.appendChild(strip);
    }, `${LABEL} / ${viewport.name} ${viewport.width}x${viewport.height} / ${state}`);
    await page.screenshot({ path: `${SHOTS}/${state}-${viewport.name}.png` });
    await page.evaluate(() => document.getElementById("qa-label")?.remove());
  }
  if (original) await page.setViewportSize(original);
}

const dragTo = async (page: Page, source: Locator, target: Locator) => {
  await source.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 15, from.y + from.height / 2 + 15, { steps: 10 });
  await target.scrollIntoViewIfNeeded();
  const to = (await target.boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await page.mouse.up();
};

test.describe("Inheritance rules QA pass 2", () => {
  test.setTimeout(240_000);
  let ws: string;
  test.beforeAll(async () => { ws = await workspaceId(); });

  test("A. unique accessible names, inactive switch, wrapping and clipping at desktop and mobile", async ({ page, base }) => {
    const stamp = Date.now();
    const n = (l: string) => `QA2 ${l} ${stamp}`;
    const target = await field(ws, "ROADMAP_ITEM", n("Target"), "SELECT", opts("a", "b"));
    const s1 = await field(ws, "OPPORTUNITY", n("OppAlpha"), "SELECT", opts("a", "b"));
    const s2 = await field(ws, "SOLUTION", n("SolBeta"), "SELECT", opts("a"));
    const s3 = await field(ws, "OPPORTUNITY", n("OppDrifted"), "SELECT", opts("a", "b"));
    await rule(ws, target, s1, "OPPORTUNITY", 0);
    await rule(ws, target, s2, "SOLUTION", 1, false);
    await rule(ws, target, s3, "OPPORTUNITY", 2);
    await sql(`UPDATE "${S}".custom_field_definitions SET options = $2::jsonb WHERE id = $1`, [s3, opts("a", "b", "zzz")]);

    await page.goto(`${base}/settings`);
    const panel = page.getByTestId("inheritance-rules");
    await expect(panel.getByRole("heading", { name: "Inheritance rules" })).toBeVisible({ timeout: 90_000 });
    const mine = panel.getByRole("listitem").filter({ hasText: n("Target") });
    await expect(mine).toHaveCount(3);

    // Unique names across every control of the whole list.
    const names = await panel.getByRole("listitem").locator("button, [role=switch]").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
    expect(names.filter((x) => !x), "every control has an accessible name").toEqual([]);
    expect([...new Set(names.filter((x, i) => names.indexOf(x) !== i))], "no duplicate accessible names").toEqual([]);
    console.log(`A11Y names (${names.length}): ${JSON.stringify(names.filter((x) => x.includes(stamp.toString())))}`);

    const rowOf = (source: string) => mine.filter({ hasText: n(source) });
    // Inactive rule: switch off and disabled, status text says why, label says inactive.
    const inactiveSwitch = rowOf("OppDrifted").getByRole("switch");
    await expect(inactiveSwitch).toBeDisabled();
    await expect(inactiveSwitch).not.toBeChecked();
    await expect(inactiveSwitch).toHaveAccessibleName(/is inactive/);
    await expect(rowOf("OppDrifted").getByTestId(/^inheritance-rule-status-/)).toContainText("Inactive: Options mismatch");
    // Disabled-by-user rule: switch off but ENABLED (can be turned on), distinct from inactive.
    await expect(rowOf("SolBeta").getByRole("switch")).not.toBeChecked();
    await expect(rowOf("SolBeta").getByRole("switch")).toBeEnabled();
    await expect(rowOf("OppAlpha").getByRole("switch")).toBeChecked();
    // Clicking a disabled inactive switch must not write.
    await inactiveSwitch.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
    expect((await sql<{ enabled: boolean }>(`SELECT enabled FROM "${S}".custom_field_inheritance_rules WHERE source_field_id = $1`, [s3]))[0].enabled).toBe(true);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await panel.scrollIntoViewIfNeeded();
      const report = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="inheritance-rules"]')!;
        const vw = window.innerWidth; const out: string[] = [];
        for (const el of root.querySelectorAll('button, [role="switch"]')) {
          const b = el.getBoundingClientRect();
          if (b.width === 0) continue;
          if (b.left < -0.5 || b.right > vw + 0.5) out.push(`off-screen ${el.getAttribute("aria-label")} ${Math.round(b.left)}..${Math.round(b.right)}/${vw}`);
        }
        for (const li of root.querySelectorAll("li")) {
          if (li.scrollWidth > li.clientWidth + 1) out.push(`row clipped ${li.scrollWidth}>${li.clientWidth}`);
          const r = li.getBoundingClientRect(); const rr = root.getBoundingClientRect();
          for (const c of li.querySelectorAll("*:not(input)")) { const b = c.getBoundingClientRect(); if (b.width && (b.right > r.right + 1 || b.left < r.left - 1)) out.push(`child escapes row: ${c.tagName}.${(c.className?.toString() ?? "").slice(0, 30)}`); }
          if (r.right > rr.right + 1) out.push("row wider than panel");
        }
        const rows = [...root.querySelectorAll("li")].map((li) => ({ h: Math.round(li.getBoundingClientRect().height), actionsBelowText: (() => { const t = li.children[0].getBoundingClientRect(), a = li.children[1].getBoundingClientRect(); return a.top >= t.bottom - 1; })() }));
        return { out, overflow: document.documentElement.scrollWidth - vw, rows };
      });
      console.log(`LAYOUT ${viewport.name}: ${JSON.stringify(report)}`);
      expect.soft(report.out, viewport.name).toEqual([]);
      expect.soft(report.overflow, `${viewport.name} document overflow`).toBeLessThanOrEqual(0);
      if (viewport.name === "mobile") expect.soft(report.rows.every((r) => r.actionsBelowText), "mobile rows wrap: actions sit below the text").toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await shot(page, "rows-unique-names-inactive-switch", mine.first());
    for (const id of [target, s1, s2, s3]) { await sql(`DELETE FROM "${S}".custom_field_inheritance_rules WHERE target_field_id=$1 OR source_field_id=$1`, [id]); await sql(`DELETE FROM "${S}".custom_field_definitions WHERE id=$1`, [id]); }
  });

  test("B. panel link journeys: fill, hand-set kept, re-link never rewrites, unlink does nothing", async ({ page, base }) => {
    const stamp = Date.now();
    const customer = await field(ws, "OPPORTUNITY", `QA2 Customer ${stamp}`, "SELECT", opts("acme", "globex"));
    const partner = await field(ws, "ROADMAP_ITEM", `QA2 Partner ${stamp}`, "SELECT", opts("acme", "globex"));
    await rule(ws, partner, customer, "OPPORTUNITY", 0);
    const oppA = `QA2 Opp Acme ${stamp}`, oppG = `QA2 Opp Globex ${stamp}`;
    const a = await opportunity(ws, oppA); const g = await opportunity(ws, oppG);
    await setValue(customer, a, "acme"); await setValue(customer, g, "globex");
    const emptyTitle = `QA2 Empty ${stamp}`, handTitle = `QA2 Hand ${stamp}`;
    const empty = await item(ws, emptyTitle); const hand = await item(ws, handTitle);
    await setValue(partner, hand, "globex");

    await page.goto(`${base}/roadmap`);
    await page.waitForLoadState("networkidle");
    const openEditor = async (title: string) => {
      const card = page.locator('[data-slot="card"]').filter({ hasText: title });
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.hover(); await card.getByLabel("Card actions").click();
      await page.getByRole("menuitem", { name: "Edit" }).click();
      const dialog = page.locator('[data-slot="sheet-content"]');
      const more = dialog.getByRole("button", { name: "More properties" });
      if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
      return dialog;
    };
    const pick = async (dialog: Locator, option: string) => { await dialog.getByRole("combobox", { name: "Opportunity" }).click(); await page.getByRole("option", { name: option }).click(); };
    const linked = async (id: string) => (await sql<{ opportunity_id: string | null }>(`SELECT opportunity_id FROM "${S}".roadmap_items WHERE id=$1`, [id]))[0].opportunity_id;

    // Empty target: link fills it.
    let dialog = await openEditor(emptyTitle);
    await pick(dialog, oppA);
    await expect.poll(() => linked(empty)).toBe(a);
    await expect.poll(() => getValue(partner, empty), { timeout: 10_000 }).toBe("acme");
    // Re-link to another opportunity: filled target is never rewritten.
    await pick(dialog, oppG);
    await expect.poll(() => linked(empty)).toBe(g);
    await page.waitForTimeout(1000);
    expect(await getValue(partner, empty)).toBe("acme");
    // Unlink: nothing changes.
    await pick(dialog, "— None —");
    await expect.poll(() => linked(empty)).toBeNull();
    await page.waitForTimeout(1000);
    expect(await getValue(partner, empty)).toBe("acme");
    await page.keyboard.press("Escape");

    // Hand-set target is not overwritten by a link.
    dialog = await openEditor(handTitle);
    await pick(dialog, oppA);
    await expect.poll(() => linked(hand)).toBe(a);
    await page.waitForTimeout(1000);
    expect(await getValue(partner, hand)).toBe("globex");
    await page.keyboard.press("Escape");
    await sql(`DELETE FROM "${S}".custom_field_inheritance_rules WHERE target_field_id=$1`, [partner]);
    await sql(`DELETE FROM "${S}".custom_field_values WHERE field_id IN ($1,$2)`, [partner, customer]);
    await sql(`DELETE FROM "${S}".roadmap_items WHERE id IN ($1,$2)`, [empty, hand]);
    await sql(`DELETE FROM "${S}".opportunities WHERE id IN ($1,$2)`, [a, g]);
    await sql(`DELETE FROM "${S}".custom_field_definitions WHERE id IN ($1,$2)`, [partner, customer]);
  });

  test("C. late-source window on real SQL: 501 active items progress past the cap, archived items are never filled", async ({ page, base }) => {
    const stamp = Date.now();
    const customerName = `QA2 CapCustomer ${stamp}`;
    const customer = await field(ws, "OPPORTUNITY", customerName, "SELECT", opts("acme", "globex"));
    const partner = await field(ws, "ROADMAP_ITEM", `QA2 CapPartner ${stamp}`, "SELECT", opts("acme", "globex"));
    await rule(ws, partner, customer, "OPPORTUNITY", 0);
    const title = `QA2 Cap Opportunity ${stamp}`;
    const opp = await opportunity(ws, title);
    await sql(`INSERT INTO "${S}".roadmap_items (id, workspace_id, title, horizon, status, sort_order, opportunity_id, created_at, updated_at) SELECT gen_random_uuid(), $1, 'QA2 bulk ' || g, 'LATER', 'ACTIVE', 70, $2, NOW(), NOW() FROM generate_series(1, 501) g`, [ws, opp]);
    await sql(`INSERT INTO "${S}".roadmap_items (id, workspace_id, title, horizon, status, sort_order, opportunity_id, created_at, updated_at) SELECT gen_random_uuid(), $1, 'QA2 archived ' || g, 'LATER', 'ARCHIVED', 71, $2, NOW(), NOW() FROM generate_series(1, 5) g`, [ws, opp]);
    const counts = async () => Object.fromEntries((await sql<{ v: string; c: string }>(`SELECT value::text v, count(*)::text c FROM "${S}".custom_field_values WHERE field_id=$1 GROUP BY value`, [partner])).map((r) => [r.v, Number(r.c)]));
    const archivedFilled = async () => Number((await sql<{ c: string }>(`SELECT count(*)::text c FROM "${S}".custom_field_values v JOIN "${S}".roadmap_items r ON r.id = v.object_id WHERE v.field_id=$1 AND r.status='ARCHIVED'`, [partner]))[0].c);
    try {
      await page.goto(`${base}/discovery`);
      await page.waitForLoadState("networkidle");
      await page.getByLabel("Group board by").click();
      await page.getByRole("option", { name: customerName, exact: true }).click();
      const column = (id: string) => page.locator(`[data-column-id="${id}"]`);
      const handle = () => page.locator('[data-slot="card"]').filter({ hasText: title }).getByRole("button", { name: `Drag to change ${customerName}` });
      await expect(column("unspecified").getByText(title)).toBeVisible({ timeout: 30_000 });
      await dragTo(page, handle(), column("option:acme"));
      await expect.poll(counts, { timeout: 20_000 }).toEqual({ '"acme"': 500 });
      console.log(`CAP first write: ${JSON.stringify(await counts())}`);
      await dragTo(page, handle(), column("option:globex"));
      await expect.poll(counts, { timeout: 20_000 }).toEqual({ '"acme"': 500, '"globex"': 1 });
      console.log(`CAP second write: ${JSON.stringify(await counts())}`);
      expect(await archivedFilled(), "archived items are never filled").toBe(0);
    } finally {
      await sql(`DELETE FROM "${S}".custom_field_values WHERE field_id = $1`, [partner]);
      await sql(`DELETE FROM "${S}".roadmap_items WHERE opportunity_id = $1`, [opp]);
      await sql(`DELETE FROM "${S}".custom_field_inheritance_rules WHERE target_field_id=$1`, [partner]);
      await sql(`DELETE FROM "${S}".custom_field_values WHERE field_id = $1`, [customer]);
      await sql(`DELETE FROM "${S}".opportunities WHERE id = $1`, [opp]);
      await sql(`DELETE FROM "${S}".custom_field_definitions WHERE id IN ($1,$2)`, [partner, customer]);
    }
  });

  test("A2. a long unbroken option name in the inactive reason wraps inside the row on mobile", async ({ page, base }) => {
    const stamp = Date.now();
    const target = await field(ws, "ROADMAP_ITEM", `QA2 LongTarget ${stamp}`, "SELECT", opts("a"));
    const source = await field(ws, "OPPORTUNITY", `QA2 LongSource ${stamp}`, "SELECT", opts("a", "zzz_long_option_name_that_the_target_does_not_have"));
    await rule(ws, target, source, "OPPORTUNITY", 0);
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base}/settings`);
      const row = page.getByTestId("inheritance-rules").getByRole("listitem").filter({ hasText: `QA2 LongTarget ${stamp}` });
      await expect(row).toBeVisible({ timeout: 90_000 });
      await expect(row.getByTestId(/^inheritance-rule-status-/)).toContainText("Inactive");
      await shot(page, "long-option-name-overflow", row);
      const clipped = await row.evaluate((li) => { const r = li.getBoundingClientRect(); return [...li.querySelectorAll("*:not(input)")].some((c) => c.getBoundingClientRect().right > r.right + 1) || li.scrollWidth > li.clientWidth + 1; });
      expect(clipped, "nothing may escape the row").toBe(false);
    } finally {
      await sql(`DELETE FROM "${S}".custom_field_inheritance_rules WHERE target_field_id=$1`, [target]);
      await sql(`DELETE FROM "${S}".custom_field_definitions WHERE id IN ($1,$2)`, [target, source]);
    }
  });

  test("D. Next dev overlay and console: /settings vs /settings/modules vs /roadmap", async ({ page, base }, testInfo) => {
    const results: Record<string, unknown> = {};
    for (const path of ["/roadmap", "/settings/modules", "/settings"]) {
      const messages: string[] = [];
      const onConsole = (m: import("@playwright/test").ConsoleMessage) => { if (["error", "warning"].includes(m.type())) messages.push(`${m.type()}: ${m.text().replace(/\s+/g, " ").slice(0, 160)}`); };
      const onError = (e: Error) => messages.push(`pageerror: ${e.message.slice(0, 200)}`);
      page.on("console", onConsole); page.on("pageerror", onError);
      await page.goto(`${base}${path}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(2500);
      const badge = await page.evaluate(() => {
        const root = document.querySelector("nextjs-portal")?.shadowRoot;
        const t = [...(root?.querySelectorAll("button, [role=button], div") ?? [])].map((e) => (e.textContent ?? "").trim()).find((x) => /^\d+\s*Issues?$/.test(x));
        return t ?? null;
      });
      page.off("console", onConsole); page.off("pageerror", onError);
      results[path] = { badge, messages };
    }
    console.log(`OVERLAY_REPORT ${JSON.stringify(results)}`);
    await testInfo.attach("overlay-report.json", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
  });
});
