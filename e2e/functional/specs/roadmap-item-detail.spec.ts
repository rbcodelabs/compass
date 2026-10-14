import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import { HORIZON_META } from "../../../lib/roadmap";

// Contrast of every horizon badge class against its own surface, resolved by the browser in the active theme.
async function horizonContrasts(page: Page) {
  return page.evaluate((classes) => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    const rgb = (css: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)); };
    const lum = ([r, g, b]: number[]) => { const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    return Object.entries(classes).map(([horizon, cls]) => {
      const el = document.createElement("span"); el.className = cls; el.textContent = horizon; document.body.append(el);
      const style = getComputedStyle(el); const [a, b] = [lum(rgb(style.color)), lum(rgb(style.backgroundColor))]; el.remove();
      return { horizon, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    });
  }, Object.fromEntries(Object.entries(HORIZON_META).map(([h, m]) => [h, m.badgeClass])));
}

async function fits(container: Locator) {
  // Inline editors intentionally extend their hover target 4px into page padding.
  // Check the viewport separately so that allowance cannot hide real page overflow.
  await expect.poll(() => container.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await expect.poll(() => container.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.scrollWidth <= element.clientWidth + 4 ? [] : Array.from(element.querySelectorAll("*")).filter(child => child.getBoundingClientRect().right > box.right + 4).map(child => ({ tag: child.tagName, text: child.textContent?.slice(0, 80), width: child.getBoundingClientRect().width }));
  })).toEqual([]);
}

async function capture(page: Page, name: string) {
  await expect(page.getByText("Loading discussion…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Post comment", exact: true })).toBeVisible();
  // Hide only development-tool chrome; do not mask application content/errors.
  await page.screenshot({ path: `public/screenshots/docs/roadmap-item-${name}.png`, fullPage: true, style: "nextjs-portal { display: none !important; }" });
}

test("roadmap item detail edits every field and fits overlay, pinned, mobile and full-page layouts", async ({ page, base }) => {
  test.setTimeout(240_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const itemId = randomUUID();
  const squadId = randomUUID();
  const fieldId = randomUUID();
  const title = "Guided setup for new workspaces — first-run checklist and sample data";
  const renamed = "Guided setup for new workspaces";
  const squadName = "QA Squad Layout Check — long running onboarding and activation experiments";
  try {
    const { rows: [workspace] } = await pool.query(
      "SELECT w.id FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON o.id=w.organization_id WHERE o.slug='e2e-test-org' AND w.slug='e2e-workspace'",
    );
    await pool.query("INSERT INTO compass_dev.squads (id, workspace_id, name, color) VALUES ($1,$2,$3,'#0ea5e9')", [squadId, workspace.id, squadName]);
    await pool.query(
      "INSERT INTO compass_dev.roadmap_items (id, workspace_id, title, description, horizon, status) VALUES ($1,$2,$3,$4,'NEXT','ACTIVE')",
      [itemId, workspace.id, title, "Help new teams reach a useful workspace in their first session, with a short checklist and realistic sample data."],
    );
    await pool.query("INSERT INTO compass_dev.custom_field_definitions (id, workspace_id, object_type, name, field_type) VALUES ($1,$2,'ROADMAP_ITEM','Release owner','TEXT')", [fieldId, workspace.id]);
    await pool.query("INSERT INTO compass_dev.custom_field_values (field_id,object_id,value) VALUES ($1,$2,$3::jsonb)", [fieldId, itemId, JSON.stringify("Platform team")]);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/roadmap?detail=roadmapItem:${itemId}`);
    const sheet = page.locator('[data-slot="sheet-content"]');
    const detail = page.locator('[data-slot="roadmap-item-detail"]');
    await expect(sheet.getByRole("button", { name: title, exact: true })).toBeVisible();
    const summary = sheet.getByLabel("Roadmap item summary");
    await expect(summary.getByRole("combobox", { name: "Horizon" })).toContainText("Next");
    await expect(summary.getByRole("button", { name: "Dates: not set" })).toBeVisible();
    await expect(summary.getByText("0 votes")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "More properties" })).toHaveAttribute("aria-expanded", "false");
    await expect(sheet.getByText("Delivery tasks", { exact: true })).toBeVisible();
    const header = sheet.locator('[data-slot="sheet-header"]');
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(48);
    await expect(header.getByRole("link", { name: "Open full page" })).toHaveAttribute("href", `${base}/roadmap/${itemId}`);
    await fits(detail);
    await capture(page, "overlay-desktop");

    // Title, squad and dates edit inline and flow back to the board card.
    await sheet.getByRole("button", { name: title, exact: true }).click();
    const titleInput = sheet.getByRole("textbox", { name: "Edit title" });
    await titleInput.fill(renamed);
    await titleInput.press("Enter");
    await expect(sheet.getByRole("button", { name: renamed, exact: true })).toBeVisible();
    await summary.getByRole("combobox", { name: "Squad", exact: true }).click();
    await page.getByRole("option", { name: squadName }).click();
    const squadTrigger = summary.getByRole("combobox", { name: "Squad", exact: true });
    await expect(squadTrigger).toContainText(squadName);
    // One colour dot, an ellipsis for the long name, and the full name on hover.
    await expect(squadTrigger).toHaveAttribute("title", squadName);
    await expect(squadTrigger.locator("span[style*=background-color]")).toHaveCount(1);
    expect(await squadTrigger.evaluate((el) => { const t = el.querySelector(".truncate")!; return t.scrollWidth > t.clientWidth && getComputedStyle(t).textOverflow === "ellipsis"; })).toBe(true);
    await fits(detail);

    // A blank title is explained, not silently dropped.
    await sheet.getByRole("button", { name: renamed, exact: true }).click();
    const blank = sheet.getByRole("textbox", { name: "Edit title" });
    await blank.fill("   ");
    await blank.press("Enter");
    await expect(sheet.getByRole("alert").filter({ hasText: "A title is required" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: renamed, exact: true })).toBeVisible();
    await summary.getByRole("button", { name: "Dates: not set" }).click();
    await sheet.getByLabel("Start date").fill("2026-07-01");
    await expect(sheet.getByRole("button", { name: "Save dates" })).toBeDisabled();
    await sheet.getByLabel("End date").fill("2026-07-31");
    await sheet.getByRole("button", { name: "Save dates" }).click();
    await expect(summary.getByRole("button", { name: "Dates: Jul 1, 2026 – Jul 31, 2026" })).toBeVisible();

    await sheet.getByRole("button", { name: "More properties" }).click();
    await sheet.getByRole("combobox", { name: "Opportunity" }).click();
    await page.getByRole("option", { name: "E2E Baseline Opportunity" }).click();
    await expect(sheet.getByRole("combobox", { name: "Opportunity" })).toContainText("E2E Baseline Opportunity");
    await sheet.getByRole("checkbox").click();
    await expect(summary.getByText("Private", { exact: true })).toBeVisible();
    await expect(sheet.getByText("E2E Baseline Opportunity").first()).toBeVisible();
    await capture(page, "properties-desktop");

    await sheet.getByRole("button", { name: "Pin panel", exact: true }).click();
    const pinned = page.locator('[data-slot="pinned-panel"]');
    await expect(pinned).toBeVisible();
    await expect(pinned.getByRole("link", { name: "Open full page" })).toBeVisible();
    await fits(detail);
    await capture(page, "pinned-desktop");
    // A new document also proves every edit survives a server read.
    await page.context().addCookies([{ name: "compass_panel_detail", value: "1:320", domain: "localhost", path: "/" }]);
    await page.reload();
    await expect(pinned.getByRole("button", { name: renamed, exact: true })).toBeVisible();
    await expect(pinned.getByRole("combobox", { name: "Squad", exact: true })).toContainText(squadName);
    await expect(pinned.getByRole("button", { name: "Dates: Jul 1, 2026 – Jul 31, 2026" })).toBeVisible();
    await expect(pinned.getByText("Private", { exact: true })).toBeVisible();
    await fits(detail);
    await capture(page, "pinned-narrow");
    // The board card in the background reflects the edits (private badge + new title).
    await expect(page.locator('[data-slot="card"]').filter({ hasText: renamed }).getByText("Private", { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(sheet).toBeVisible();
    await expect(pinned).toHaveCount(0);
    await fits(detail);
    await capture(page, "overlay-mobile");
    await page.setViewportSize({ width: 320, height: 740 });
    await fits(detail);
    await capture(page, "overlay-320");
    await sheet.getByRole("link", { name: "Open full page" }).click();
    await expect(page).toHaveURL(new RegExp(`/roadmap/${itemId}$`));
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole("button", { name: renamed, exact: true })).toBeVisible();
    await fits(detail);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, "fullpage-mobile");
    await page.setViewportSize({ width: 1280, height: 800 });
    // Wide containers place the discussion beside the content.
    const main = page.locator('[data-slot="roadmap-item-detail-main"]');
    const discussion = page.locator('[data-slot="roadmap-item-detail-discussion"]');
    const [mainBox, discussionBox] = [await main.boundingBox(), await discussion.boundingBox()];
    expect(discussionBox!.x).toBeGreaterThan(mainBox!.x + mainBox!.width - 1);
    await fits(detail);
    await capture(page, "fullpage-desktop");

    // Horizon pills keep readable contrast in light and dark for every horizon.
    for (const { horizon, ratio } of await horizonContrasts(page)) expect(ratio, `light ${horizon}`).toBeGreaterThanOrEqual(4.5);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => localStorage.setItem("compass-theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    for (const { horizon, ratio } of await horizonContrasts(page)) expect(ratio, `dark ${horizon}`).toBeGreaterThanOrEqual(4.5);
    await capture(page, "fullpage-dark");
    await page.evaluate(() => localStorage.removeItem("compass-theme"));
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();

    // Archiving from the full page removes the card from the board.
    // The reader's disclosure choice is remembered, so open it only if it is shut.
    const more = page.getByRole("button", { name: "More properties" });
    if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
    await page.getByRole("button", { name: "Archive item" }).click();
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
    await page.goto(`${base}/roadmap`);
    await expect(page.locator('[data-slot="card"]').filter({ hasText: renamed })).toHaveCount(0);
  } finally {
    await pool.query("DELETE FROM compass_dev.custom_field_values WHERE field_id=$1", [fieldId]);
    await pool.query("DELETE FROM compass_dev.custom_field_definitions WHERE id=$1", [fieldId]);
    await pool.query("DELETE FROM compass_dev.roadmap_items WHERE id=$1", [itemId]);
    await pool.query("DELETE FROM compass_dev.squads WHERE id=$1", [squadId]);
    await pool.end();
  }
});

test("roadmap item full page 404s for a malformed or unknown id", async ({ page, base }) => {
  expect((await page.goto(`${base}/roadmap/not-a-uuid`))!.status()).toBe(404);
  expect((await page.goto(`${base}/roadmap/${randomUUID()}`))!.status()).toBe(404);
});
