import pg from "pg";
import { test, expect } from "../fixtures/index";
import { assertIsolatedE2EDatabase, isolatedE2EConnectionString } from "../fixtures/isolated-database";
import type { Locator, Page } from "@playwright/test";

const nativeId = "3eaf938a-782c-4073-a452-070d54156896";
const nativeBase = "/e2e-test-org/native-dogfood";
const start = new Date().toISOString().slice(0, 8) + "01";
const end = new Date().toISOString().slice(0, 8) + "28";

function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function targetBounds(target: Locator) {
  const bounds = await target.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

async function scrollToFixtureMonth(page: Page) {
  const month = new Date(`${start}T12:00:00Z`);
  const viewportStart = new Date(month);
  viewportStart.setUTCMonth(viewportStart.getUTCMonth() - 2);
  const offset = (month.getTime() - viewportStart.getTime()) / 86_400_000 * 12;
  // The virtualized chart initially starts two months before today. Scroll
  // the real date region before querying cards outside its render window.
  await page.getByTestId("native-timeline-scroll").evaluate((element, left) => { element.scrollLeft = left; }, offset);
}

test.describe("Native timeline limited rollout", () => {
  test.beforeAll(async () => {
    // Mirror only the cohort identity in disposable, sentinel-protected local
    // Postgres. Never relax the production gate for tests. Global teardown
    // owns every workspace beneath this run's e2e-test-org.
    await assertIsolatedE2EDatabase();
    const pool = new pg.Client({ connectionString: isolatedE2EConnectionString() });
    await pool.connect();
    try {
      await pool.query("BEGIN");
      const existing = await pool.query(`SELECT w.id FROM compass_dev.workspaces w
        JOIN compass_dev.organizations o ON o.id = w.organization_id
        WHERE w.id = $1 AND w.slug = 'native-dogfood' AND o.slug = 'e2e-test-org'`, [nativeId]);
      if (existing.rowCount) {
        await pool.query("COMMIT");
        return; // A failed test restarts its worker, not the owned fixture.
      }
      await pool.query(`INSERT INTO compass_dev.workspaces
        (id, organization_id, slug, name, roadmap_public, feedback_enabled, created_at, updated_at)
        SELECT $1, id, 'native-dogfood', 'Native timeline dogfood', false, false, NOW(), NOW()
        FROM compass_dev.organizations WHERE slug = 'e2e-test-org'`, [nativeId]);
      await pool.query(`INSERT INTO compass_dev.workspace_members (id, workspace_id, user_id, role, created_at)
        SELECT gen_random_uuid(), $1, id, 'ADMIN', NOW() FROM compass_dev.users WHERE email = 'dev@localhost.dev'`, [nativeId]);
      for (const name of ["Alpha", "Beta"]) {
        const { rows: [squad] } = await pool.query(`INSERT INTO compass_dev.squads (id, workspace_id, name, color, created_at)
          VALUES (gen_random_uuid(), $1, $2, '#6366f1', NOW()) RETURNING id`, [nativeId, name]);
        await pool.query(`INSERT INTO compass_dev.roadmap_items
          (id, workspace_id, squad_id, title, horizon, status, sort_order, start_date, end_date, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, $2, $3, 'NEXT', 'ACTIVE', 0, $4, $5, NOW(), NOW())`, [nativeId, squad.id, `${name} delivery`, start, end]);
      }
      await pool.query(`INSERT INTO compass_dev.feedback (id, workspace_id, title, type, status, vote_count, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, 'Native backlog bug', 'BUG', 'OPEN', 0, NOW(), NOW())`, [nativeId]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    } finally { await pool.end(); }
  });

  for (const theme of ["dark", "light"] as const) {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      test(`native timeline ${theme} appearance at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.addInitScript((value) => localStorage.setItem("compass-theme", value), theme);
        await page.goto(`${nativeBase}/roadmap?view=timeline`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const title = page.getByText("Compass native timeline", { exact: true });
        await expect(title).toBeVisible();
        // Resolve the actual painted surface, including transparent ancestors,
        // and convert CSS colors (including oklch) through the browser canvas.
        const contrast = await title.evaluate((element) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          function luminance(color: string) {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            const rgb = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map((value) => {
              const channel = value / 255;
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
          }
          let surface: Element | null = element;
          while (surface && getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)") surface = surface.parentElement;
          const foreground = luminance(getComputedStyle(element).color);
          const background = luminance(getComputedStyle(surface!).backgroundColor);
          return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
        });
        expect(contrast, "timeline title contrast against its painted toolbar").toBeGreaterThanOrEqual(4.5);
        const cardColor = await page.evaluate(() => {
          const probe = document.createElement("div");
          probe.style.backgroundColor = "var(--card)";
          document.body.append(probe);
          const value = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return value;
        });
        await expect(title.locator("../..")).toHaveCSS("background-color", cardColor);
        const scroll = page.getByTestId("native-timeline-scroll");
        await expect(scroll.locator("../..")).toHaveCSS("background-color", cardColor);
        await expect(scroll.locator("../div").first()).toHaveCSS("background-color", cardColor);
        await expect(scroll.locator(":scope > div > div").first()).toHaveCSS("background-color", cardColor);
        await expect(page.locator("#unscheduled-items-panel [data-slot=badge]").first()).toHaveCSS("background-color", cardColor);
        const grid = page.getByTestId("timeline-grid");
        expect(await grid.evaluate((element) => getComputedStyle(element).backgroundImage)).not.toContain("226, 232, 240");
        await scrollToFixtureMonth(page);
        await page.screenshot({ path: `public/screenshots/docs/native-timeline-${theme}-${viewport.width}.png`, fullPage: true, style: "nextjs-portal { display: none }" });
        await page.getByRole("button", { name: "Edit dates for Beta delivery", exact: true }).click();
        await expect(page.getByRole("dialog").getByLabel("Start", { exact: true })).toHaveValue(start);
        await expect(page.getByRole("dialog").getByRole("combobox")).toHaveCSS("background-color", cardColor);
        await expect(page.getByRole("dialog").getByLabel("Start", { exact: true })).toHaveCSS("background-color", cardColor);
        await expect(page.getByRole("dialog").getByLabel("End", { exact: true })).toHaveCSS("background-color", cardColor);
        await page.screenshot({ path: `public/screenshots/docs/native-timeline-editor-${theme}-${viewport.width}.png`, style: "nextjs-portal { display: none }" });
        await page.keyboard.press("Escape");
      });
    }
  }

  test("native scheduling persists, classic fallback and board remain available", async ({ page }) => {
    await page.goto(`${nativeBase}/roadmap`);
    await page.getByRole("button", { name: "Add item", exact: true }).nth(1).click();
    await page.getByLabel("Title", { exact: true }).fill("Native rollout scheduling");
    await page.getByRole("button", { name: "Add Item", exact: true }).click();
    await expect(page.getByText("Native rollout scheduling", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await expect(page.getByRole("link", { name: "Use classic timeline" })).toBeVisible();
    await page.getByRole("button", { name: "Edit dates for Native rollout scheduling", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Start", { exact: true }).fill(start);
    await dialog.getByLabel("End", { exact: true }).fill(end);
    await dialog.getByRole("button", { name: "Save schedule", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Edit dates for Native rollout scheduling", exact: true }).click();
    await expect(dialog.getByLabel("Start", { exact: true })).toHaveValue(start);
    await expect(dialog.getByLabel("End", { exact: true })).toHaveValue(end);
    await page.keyboard.press("Escape");
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await scrollToFixtureMonth(page);
      await page.screenshot({ path: `public/screenshots/docs/native-timeline-${viewport.width}.png`, fullPage: true, style: "nextjs-portal { display: none }" });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("link", { name: "Use classic timeline" }).click();
    await expect(page).toHaveURL(/timelineEngine=classic/);
    await expect(page.getByRole("tab", { name: "Year", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add item", exact: true }).first()).toBeVisible();
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Year", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/timelineEngine=classic/);
    await page.getByRole("link", { name: "Use native timeline" }).click();
    await expect(page.getByRole("link", { name: "Use classic timeline" })).toBeVisible();
  });

  test("squad filter drops old native rows and survives renderer fallback", async ({ page }) => {
    await page.goto(`${nativeBase}/roadmap?view=timeline`);
    await expect(page.getByRole("button", { name: /Open details for Alpha delivery/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Open details for Beta delivery/ })).toBeVisible();
    await page.getByRole("button", { name: /Filters/ }).click();
    await page.getByRole("menuitemradio", { name: "Alpha", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /Open details for Alpha delivery/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Open details for Beta delivery/ })).toHaveCount(0);
    const squad = new URL(page.url()).searchParams.get("squad");
    await page.getByRole("link", { name: "Use classic timeline" }).click();
    expect(new URL(page.url()).searchParams.get("squad")).toBe(squad);
    await page.getByRole("link", { name: "Use native timeline" }).click();
    expect(new URL(page.url()).searchParams.get("squad")).toBe(squad);
    await expect(page.getByRole("button", { name: /Open details for Beta delivery/ })).toHaveCount(0);
  });

  test("compact border grips and dotted handle preserve independent pointer and keyboard edits", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${nativeBase}/roadmap?view=timeline`);
    await scrollToFixtureMonth(page);
    const move = page.getByRole("button", { name: "Move Alpha delivery", exact: true });
    const left = page.getByRole("button", { name: "Resize left edge of Alpha delivery", exact: true });
    const right = page.getByRole("button", { name: "Resize right edge of Alpha delivery", exact: true });
    const details = page.getByRole("button", { name: /Open details for Alpha delivery/ });
    const edit = page.getByRole("button", { name: "Edit dates for Alpha delivery", exact: true });
    const card = page.locator('[data-testid^="timeline-item-"][data-start]').filter({ has: move });
    await expect(move.locator("svg.lucide-grip-vertical")).toBeVisible();
    await move.scrollIntoViewIfNeeded();

    const [leftBox, moveBox, detailsBox, editBox, rightBox] = await Promise.all(
      [left, move, details, edit, right].map(targetBounds),
    );
    expect(leftBox.width).toBe(24);
    expect(moveBox.width).toBe(24);
    expect(rightBox.width).toBe(24);
    expect(leftBox.x + leftBox.width).toBeLessThanOrEqual(moveBox.x);
    expect(moveBox.x + moveBox.width).toBeLessThanOrEqual(detailsBox.x);
    expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(editBox.x);
    expect(editBox.x + editBox.width).toBeLessThanOrEqual(rightBox.x);
    // Previously the move gutter was 28 + 24 + 4px and the edit gutter
    // 24 + 28px. Four adjacent 24px targets now reserve 96 rather than 108px.
    expect(moveBox.x + moveBox.width - leftBox.x + rightBox.x + rightBox.width - editBox.x).toBe(96);

    const initialStart = (await card.getAttribute("data-start"))!;
    const initialEnd = (await card.getAttribute("data-end"))!;
    async function drag(target: Locator, pixels: number) {
      await target.scrollIntoViewIfNeeded();
      const box = await targetBounds(target);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + pixels, box.y + box.height / 2, { steps: 6 });
      await page.mouse.up();
    }
    await drag(left, 12);
    await expect(card).toHaveAttribute("data-start", shiftDate(initialStart, 1));
    await expect(move).toBeEnabled();
    await drag(right, 12);
    await expect(card).toHaveAttribute("data-end", shiftDate(initialEnd, 1));
    await expect(move).toBeEnabled();
    await drag(move, 12);
    await expect(card).toHaveAttribute("data-start", shiftDate(initialStart, 2));
    await expect(card).toHaveAttribute("data-end", shiftDate(initialEnd, 2));
    await expect(move).toBeEnabled();
    await page.reload();
    await expect(card).toHaveAttribute("data-start", shiftDate(initialStart, 2));
    await expect(card).toHaveAttribute("data-end", shiftDate(initialEnd, 2));

    await move.focus();
    await page.keyboard.press("Alt+ArrowLeft");
    await expect(card).toHaveAttribute("data-start", shiftDate(initialStart, 1));
    await expect(move).toBeEnabled();
    await right.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(card).toHaveAttribute("data-end", initialEnd);
    await expect(move).toBeEnabled();
    await move.focus();
    await page.keyboard.press("d");
    await expect(page.getByRole("dialog").getByLabel("Start", { exact: true })).toHaveValue(shiftDate(initialStart, 1));
    await page.keyboard.press("Escape");
    await details.click();
    await expect(page).toHaveURL(/detail=roadmapItem/);
    const detailPanel = page.getByRole("dialog", { name: "Roadmap Item", exact: true });
    await expect(detailPanel.getByRole("button", { name: "Alpha delivery", exact: true })).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/detail=/);
    await expect(detailPanel).not.toBeVisible();
    await expect(details).toBeFocused();
    await expect(card).toHaveAttribute("data-start", shiftDate(initialStart, 1));
    await expect(card).toHaveAttribute("data-end", initialEnd);

    await edit.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Start", { exact: true }).fill(initialStart);
    await dialog.getByLabel("End", { exact: true }).fill(shiftDate(initialStart, 10));
    await dialog.getByRole("button", { name: "Save schedule", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(move).toBeEnabled();
    expect((await targetBounds(card)).width).toBe(132);
    expect((await targetBounds(details)).width).toBeGreaterThanOrEqual(24);
    await expect(details).toHaveCSS("overflow", "hidden");
    await expect(details.getByLabel("Delivery status: Not Started", { exact: true })).not.toBeVisible();
    expect((await targetBounds(details.locator("[data-timeline-title]"))).width).toBeGreaterThan(0);
    await page.screenshot({ path: "public/screenshots/docs/native-timeline-narrow-1280.png", fullPage: true, style: "nextjs-portal { display: none }" });
    await edit.click();
    await dialog.getByLabel("End", { exact: true }).fill(shiftDate(initialStart, 9));
    await dialog.getByRole("button", { name: "Save schedule", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Edit schedule for Alpha delivery", exact: true })).toBeVisible();
    await expect(move).toHaveCount(0);
  });

  test("query cannot opt another workspace into native", async ({ page, base }) => {
    await page.goto(`${base}/roadmap?view=timeline&timelineEngine=native`);
    await expect(page.getByRole("tab", { name: "Year", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Use classic timeline" })).toHaveCount(0);
  });

  test.describe("touch targets", () => {
    test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

    test("narrow-looking grips retain independent targets and a tappable date dialog", async ({ page }) => {
      await page.goto(`${nativeBase}/roadmap?view=timeline`);
      await scrollToFixtureMonth(page);
      const move = page.getByRole("button", { name: "Move Beta delivery", exact: true });
      const left = page.getByRole("button", { name: "Resize left edge of Beta delivery", exact: true });
      const right = page.getByRole("button", { name: "Resize right edge of Beta delivery", exact: true });
      const details = page.getByRole("button", { name: /Open details for Beta delivery/ });
      const edit = page.getByRole("button", { name: "Edit dates for Beta delivery", exact: true });
      const [leftBox, moveBox, detailsBox, editBox, rightBox] = await Promise.all(
        [left, move, details, edit, right].map(targetBounds),
      );
      for (const box of [leftBox, moveBox, editBox, rightBox]) {
        expect(box.width).toBeGreaterThanOrEqual(24);
        expect(box.height).toBeGreaterThanOrEqual(24);
      }
      expect(leftBox.x + leftBox.width).toBeLessThanOrEqual(moveBox.x);
      expect(moveBox.x + moveBox.width).toBeLessThanOrEqual(detailsBox.x);
      expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(editBox.x);
      expect(editBox.x + editBox.width).toBeLessThanOrEqual(rightBox.x);
      expect((await targetBounds(left.locator("[data-resize-grip]"))).width).toBe(2);
      await expect(edit).toHaveCSS("opacity", "1");
      await edit.tap();
      await expect(page.getByRole("dialog").getByLabel("Start", { exact: true })).toHaveValue(start);
      await expect(page.getByRole("dialog").getByLabel("End", { exact: true })).toHaveValue(end);
      await page.getByRole("button", { name: "Close", exact: true }).first().tap();
      await expect(page.getByRole("dialog")).not.toBeVisible();
    });
  });

  test("native backlog quick-add persists on the roadmap", async ({ page }) => {
    await page.goto(`${nativeBase}/roadmap?view=timeline`);
    const backlog = page.locator('[data-testid^="unscheduled-item-"]').filter({ hasText: "Native backlog bug" });
    await backlog.getByRole("button", { name: "Card actions" }).click();
    await page.getByRole("menuitem", { name: "Add to Next", exact: true }).click();
    await expect(backlog).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-testid^="unscheduled-item-"]').filter({ hasText: "Native backlog bug" })).toHaveCount(0);
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    await expect(page.getByText("Native backlog bug", { exact: true })).toBeVisible();
  });
});
