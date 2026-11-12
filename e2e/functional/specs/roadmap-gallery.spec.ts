import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Roadmap Gallery view (?view=gallery): one large card per roadmap item whose hero is the screenshot of an
 * Artifact linked to the item's Solution. Rows are seeded straight into the database (a screenshot capture
 * needs a remote sandbox, which functional runs do not have); the real page, thumbnail route and controls are driven.
 */
const S = "compass_dev";
// 1x1 PNG; the thumbnail route serves whatever bytes are in storage and the card renders it as an <img>.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("gallery shows previews, filmstrip, placeholders, grouping and stays usable on mobile", async ({ page, base, workspaceSlug }, testInfo) => {
  test.setTimeout(180_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const suffix = randomUUID().slice(0, 8);
  const titles = { shot: `Gallery shot ${suffix}`, pending: `Gallery pending ${suffix}`, bare: `Gallery bare ${suffix}` };
  try {
    const ws = (await pool.query(`SELECT w.id FROM "${S}".workspaces w WHERE w.slug = $1`, [workspaceSlug])).rows[0].id as string;
    const opp = (await pool.query(`SELECT id FROM "${S}".opportunities WHERE workspace_id = $1 LIMIT 1`, [ws])).rows[0].id as string;

    const solution = async (title: string, status: string) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO "${S}".solutions (id, workspace_id, opportunity_id, title, status) VALUES ($1, $2, $3, $4, $5)`, [id, ws, opp, title, status]);
      return id;
    };
    const artifact = async (title: string, solutionId: string, withThumbnail: boolean) => {
      const id = randomUUID();
      const rev = randomUUID();
      const thumb = `artifacts/${ws}/${id}/thumbnails/${rev}-gallery.png`;
      await pool.query(`INSERT INTO "${S}".artifacts (id, workspace_id, title, source_type) VALUES ($1, $2, $3, 'HTML_UPLOAD')`, [id, ws, title]);
      await pool.query(
        `INSERT INTO "${S}".artifact_revisions (id, artifact_id, revision_number, blob_pathname, mime_type, thumbnail_pathname, thumbnail_mime_type, thumbnail_byte_size, thumbnail_width, thumbnail_height, thumbnail_captured_at)
         VALUES ($1, $2, 1, $3, 'text/html', $4, $5, $6, $7, $8, $9)`,
        [rev, id, `artifacts/${ws}/${id}/page.html`, withThumbnail ? thumb : null, withThumbnail ? "image/png" : null, withThumbnail ? PNG.length : null, withThumbnail ? 1 : null, withThumbnail ? 1 : null, withThumbnail ? new Date() : null],
      );
      await pool.query(`UPDATE "${S}".artifacts SET current_revision_id = $1 WHERE id = $2`, [rev, id]);
      await pool.query(
        `INSERT INTO "${S}".entity_links (workspace_id, link_type, from_type, from_id, to_type, to_id, origin, source, created_at, updated_at)
         VALUES ($1, 'ARTIFACT_ATTACHED_TO_SOLUTION', 'ARTIFACT', $2, 'SOLUTION', $3, 'DIRECT', 'UI', NOW(), NOW())`,
        [ws, id, solutionId],
      );
      if (withThumbnail) {
        const target = path.join("/tmp", "compass-artifacts", thumb);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, PNG);
      }
    };
    const item = (title: string, solutionId: string | null, horizon: string, isPrivate = false) =>
      pool.query(`INSERT INTO "${S}".roadmap_items (workspace_id, title, horizon, solution_id, is_private) VALUES ($1, $2, $3, $4, $5)`, [ws, title, horizon, solutionId, isPrivate]);

    const shotSolution = await solution(`Shot solution ${suffix}`, "IN_DELIVERY");
    await artifact(`Newest shot ${suffix}`, shotSolution, true);
    await artifact(`Uncaptured second ${suffix}`, shotSolution, false);
    const pendingSolution = await solution(`Pending solution ${suffix}`, "VALIDATED");
    await artifact(`Uncaptured only ${suffix}`, pendingSolution, false);
    await item(titles.shot, shotSolution, "NEXT");
    await item(titles.pending, pendingSolution, "LATER", true);
    await item(titles.bare, null, "LATER");

    // ── Desktop: the view switch and the cards ───────────────────────────────
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/roadmap`);
    await page.getByRole("tab", { name: "Gallery", exact: true }).click();
    await expect(page).toHaveURL(/view=gallery/);
    const gallery = page.getByTestId("roadmap-gallery");
    await expect(gallery).toBeVisible();

    const card = (title: string) => gallery.locator('[data-testid="gallery-card"]').filter({ hasText: title });

    // Screenshot hero, served through the authenticated thumbnail route.
    const shot = card(titles.shot);
    // The hero itself (not a filmstrip thumbnail) must default to the artifact that has a screenshot, even though a newer artifact has none.
    const hero = shot.getByRole("img", { name: `Preview of Newest shot ${suffix}` });
    await expect(hero).toBeVisible();
    await expect(shot.getByTestId("gallery-hero-pending")).toHaveCount(0);
    await expect.poll(() => hero.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("gallery-hero-desktop-1280.png") });
    // Two artifacts → a filmstrip; focusing the second swaps the hero to its "no preview" state.
    await expect(shot.getByRole("group", { name: "Artifacts" }).getByRole("button")).toHaveCount(2);
    await shot.getByRole("button", { name: `Show Uncaptured second ${suffix}` }).click();
    await expect(shot.getByTestId("gallery-hero-pending")).toBeVisible();
    await expect(shot.getByRole("button", { name: "Capture preview" })).toBeVisible();

    // Artifact linked but never captured.
    const pending = card(titles.pending);
    await expect(pending.getByTestId("gallery-hero-pending")).toBeVisible();
    await expect(pending.getByText("Private")).toBeVisible();

    // No solution at all still gets a card.
    await expect(card(titles.bare).getByTestId("gallery-hero-empty")).toBeVisible();

    // ── Grouping ─────────────────────────────────────────────────────────────
    await page.getByRole("combobox", { name: "Group gallery by" }).click();
    await page.getByRole("option", { name: "Solution status" }).click();
    await expect(page).toHaveURL(/groupBy=status/);
    await expect(gallery.getByRole("heading", { name: "In delivery" })).toBeVisible();
    await expect(gallery.getByRole("heading", { name: "No solution" })).toBeVisible();
    // Collapsing a group hides its cards.
    await gallery.getByRole("button", { name: /In delivery/ }).click();
    await expect(card(titles.shot)).toBeHidden();
    await gallery.getByRole("button", { name: /In delivery/ }).click();
    await expect(card(titles.shot)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("gallery-desktop-1280.png") });

    // ── The card opens the usual item panel ──────────────────────────────────
    await card(titles.bare).getByRole("button", { name: titles.bare }).click();
    await expect(page).toHaveURL(/detail=roadmapItem/);
    await page.goto(`${base}/roadmap?view=gallery&groupBy=status`);

    // Board and Timeline still load when the URL carries the Gallery-only grouping.
    await page.goto(`${base}/roadmap?groupBy=status`);
    await expect(page.getByRole("tab", { name: "Board", exact: true })).toBeVisible();

    // ── Mobile ───────────────────────────────────────────────────────────────
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/roadmap?view=gallery`);
    await expect(card(titles.shot)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("gallery-mobile-390.png") });
  } finally {
    // The functional suite shares one workspace across specs in a run, so leave nothing behind: leftover LATER items broke
    // roadmap-pinned-columns.spec.ts's column counts when both ran in the same invocation.
    const like = `%${suffix}`;
    await pool.query(`DELETE FROM "${S}".roadmap_items WHERE title LIKE $1`, [like]);
    await pool.query(`DELETE FROM "${S}".entity_links WHERE link_type = 'ARTIFACT_ATTACHED_TO_SOLUTION' AND from_id IN (SELECT id FROM "${S}".artifacts WHERE title LIKE $1)`, [like]);
    await pool.query(`DELETE FROM "${S}".artifact_revisions WHERE artifact_id IN (SELECT id FROM "${S}".artifacts WHERE title LIKE $1)`, [like]);
    await pool.query(`DELETE FROM "${S}".artifacts WHERE title LIKE $1`, [like]);
    await pool.query(`DELETE FROM "${S}".solutions WHERE title LIKE $1`, [like]);
    await pool.end();
  }
});
