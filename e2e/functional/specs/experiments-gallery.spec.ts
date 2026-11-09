import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Experiments Gallery view (?view=gallery): one large card per experiment whose hero is the screenshot of an
 * Artifact linked to the experiment (ARTIFACT_ATTACHED_TO_EXPERIMENT). Rows are seeded straight into the database
 * (a screenshot capture needs a remote sandbox, which functional runs do not have); the real page, thumbnail route
 * and controls are driven.
 */
const S = "compass_dev";
// 1x1 PNG; the thumbnail route serves whatever bytes are in storage and the card renders it as an <img>.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("experiments gallery: previews, filmstrip, placeholders, grouping, filter, panel, board round trip and mobile", async ({ page, base, workspaceSlug }, testInfo) => {
  test.setTimeout(240_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const suffix = randomUUID().slice(0, 8);
  const title = (name: string) => `Gx ${name} ${suffix}`;
  const squadNames = { alpha: `Alpha ${suffix}`, beta: `Beta ${suffix}` };
  try {
    const ws = (await pool.query(`SELECT w.id FROM "${S}".workspaces w WHERE w.slug = $1`, [workspaceSlug])).rows[0].id as string;

    const squad = async (name: string, color: string) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO "${S}".squads (id, workspace_id, name, color) VALUES ($1, $2, $3, $4)`, [id, ws, name, color]);
      return id;
    };
    const experiment = async (name: string, status: string, opts: { squadId?: string; conclusion?: string } = {}) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO "${S}".experiments (id, workspace_id, title, hypothesis, method, kill_condition, status, conclusion, squad_id, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'Prototype', 'Stop if flat', $5, $6, $7, -9000, NOW(), NOW())`,
        [id, ws, title(name), `We believe ${name} ${suffix} moves the metric`, status, opts.conclusion ?? null, opts.squadId ?? null],
      );
      return id;
    };
    let tick = 0;
    const artifact = async (name: string, experimentId: string, o: { shot?: boolean; status?: string } = {}) => {
      const id = randomUUID();
      const rev = randomUUID();
      const thumb = `artifacts/${ws}/${id}/thumbnails/${rev}-gallery.png`;
      // Strictly increasing updated_at so "newest first" is deterministic.
      await pool.query(`INSERT INTO "${S}".artifacts (id, workspace_id, title, source_type, status, created_at, updated_at) VALUES ($1, $2, $3, 'HTML_UPLOAD', $4, NOW() + ($5 || ' seconds')::interval, NOW() + ($5 || ' seconds')::interval)`, [id, ws, name, o.status ?? "ACTIVE", String(++tick)]);
      await pool.query(
        `INSERT INTO "${S}".artifact_revisions (id, artifact_id, revision_number, blob_pathname, mime_type, thumbnail_pathname, thumbnail_mime_type, thumbnail_byte_size, thumbnail_width, thumbnail_height, thumbnail_captured_at)
         VALUES ($1, $2, 1, $3, 'text/html', $4, $5, $6, $7, $8, $9)`,
        [rev, id, `artifacts/${ws}/${id}/page.html`, o.shot ? thumb : null, o.shot ? "image/png" : null, o.shot ? PNG.length : null, o.shot ? 1 : null, o.shot ? 1 : null, o.shot ? new Date() : null],
      );
      await pool.query(`UPDATE "${S}".artifacts SET current_revision_id = $1 WHERE id = $2`, [rev, id]);
      await pool.query(
        `INSERT INTO "${S}".entity_links (workspace_id, link_type, from_type, from_id, to_type, to_id, origin, source, created_at, updated_at)
         VALUES ($1, 'ARTIFACT_ATTACHED_TO_EXPERIMENT', 'ARTIFACT', $2, 'EXPERIMENT', $3, 'DIRECT', 'UI', NOW(), NOW())`,
        [ws, id, experimentId],
      );
      if (o.shot) {
        const target = path.join("/tmp", "compass-artifacts", thumb);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, PNG);
      }
    };

    const alpha = await squad(squadNames.alpha, "#2563eb");
    const beta = await squad(squadNames.beta, "#dc2626");
    const shotExp = await experiment("shot", "RUNNING", { squadId: alpha });
    // Oldest artifact has the screenshot; the two newer ones do not. The hero must still open on the screenshot.
    await artifact(`Old shot ${suffix}`, shotExp, { shot: true });
    await artifact(`Uncaptured mid ${suffix}`, shotExp);
    await artifact(`Uncaptured newest ${suffix}`, shotExp);
    const pendingExp = await experiment("pending", "DESIGNING", { squadId: alpha });
    await artifact(`Only uncaptured ${suffix}`, pendingExp);
    await experiment("bare", "COMPLETE", { squadId: beta, conclusion: "PROCEED" });
    await experiment("killed", "KILLED", { conclusion: "KILL" });
    const manyExp = await experiment("many", "RUNNING");
    for (let i = 0; i < 8; i++) await artifact(`Many ${i} ${suffix}`, manyExp);
    const archivedExp = await experiment("archived", "DESIGNING");
    await artifact(`Archived only ${suffix}`, archivedExp, { status: "ARCHIVED" });

    const gallery = page.getByTestId("experiments-gallery");
    const card = (name: string) => gallery.locator('[data-testid="gallery-card"]').filter({ has: page.getByRole("button", { name: title(name), exact: true }) });
    const noHorizontalOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    // ── Board first: pin a column so the dock layout exists, then switch ───────────────────────────
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/experiments`);
    const layoutKey = `compass:experiments-column-layout:${ws}`;
    const pinned = JSON.stringify({ columnOrder: ["DESIGNING", "RUNNING", "COMPLETE", "KILLED"], pinnedColumnIds: ["KILLED"], activePinnedId: "KILLED", dockCollapsed: false });
    await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [layoutKey, pinned]);
    await page.reload();
    await expect(page.getByTestId("board-pinned-region")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("tab", { name: "Board", exact: true })).toHaveAttribute("aria-selected", "true");

    // ── Switch to Gallery; Board is the absence of the param ───────────────────────────────────────
    await page.getByRole("tab", { name: "Gallery", exact: true }).click();
    await expect(page).toHaveURL(/view=gallery/);
    await expect(gallery).toBeVisible();
    await expect(page.getByTestId("board-pinned-region")).toHaveCount(0);

    // Screenshot hero (not a filmstrip thumbnail) defaults to the artifact that has one, though two newer ones do not.
    const shot = card("shot");
    const hero = shot.getByRole("img", { name: `Preview of Old shot ${suffix}` });
    await expect(hero).toBeVisible();
    await expect(shot.getByTestId("gallery-hero-pending")).toHaveCount(0);
    await expect.poll(() => hero.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    // Card content: status, hypothesis, squad.
    await expect(shot.getByText(`We believe shot ${suffix} moves the metric`)).toBeVisible();
    await expect(shot.getByText(squadNames.alpha)).toBeVisible();
    await expect(shot.getByText("Running", { exact: true })).toBeVisible();
    // Captured while the hero still shows the screenshot (the hover below swaps it to the uncaptured artifact).
    await page.mouse.move(1270, 790);
    await page.screenshot({ path: testInfo.outputPath("experiments-gallery-desktop-1280.png") });
    await shot.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("experiments-gallery-hero-desktop-1280.png") });
    // Filmstrip of three, hovering swaps the hero.
    await expect(shot.getByRole("group", { name: "Artifacts" }).getByRole("button")).toHaveCount(3);
    await shot.getByRole("button", { name: `Show Uncaptured newest ${suffix}` }).hover();
    await expect(shot.getByTestId("gallery-hero-pending")).toBeVisible();
    await expect(shot.getByRole("button", { name: "Capture preview" })).toBeVisible();

    // Linked but never captured; many artifacts cap at 6 with "+5" (8 linked, 3 in the filmstrip).
    await expect(card("pending").getByTestId("gallery-hero-pending")).toBeVisible();
    await expect(card("many").getByRole("group", { name: "Artifacts" }).getByRole("button")).toHaveCount(3);
    await expect(card("many").getByText("+5", { exact: true })).toBeVisible();
    // No artifact (and an archived-only one) gets the placeholder that says where to link.
    await expect(card("bare").getByTestId("gallery-hero-empty")).toContainText("link an artifact from the experiment panel");
    await expect(card("archived").getByTestId("gallery-hero-empty")).toBeVisible();
    // Concluded experiments show their conclusion.
    await expect(card("bare").getByText("Proceed", { exact: true })).toBeVisible();
    await expect(card("killed").getByText("Kill", { exact: true })).toBeVisible();
    await expect(card("pending").getByText("Proceed", { exact: true })).toHaveCount(0);

    // ── Grouping: status (default, board order), squad, conclusion, none ───────────────────────────
    const headings = () => gallery.getByRole("heading", { level: 2 }).allTextContents();
    const statusHeadings = (await headings()).filter((h) => ["Designing", "Running", "Complete", "Killed"].includes(h));
    expect(statusHeadings).toEqual(["Designing", "Running", "Complete", "Killed"]);

    const groupBy = async (option: string) => {
      await page.getByRole("combobox", { name: "Group gallery by" }).click();
      await page.getByRole("option", { name: option, exact: true }).click();
    };
    await groupBy("Squad");
    await expect(page).toHaveURL(/groupBy=squad/);
    await expect(gallery.getByRole("heading", { level: 2, name: squadNames.alpha, exact: true })).toBeVisible();
    await expect(gallery.getByRole("heading", { level: 2, name: squadNames.beta, exact: true })).toBeVisible();
    await expect(gallery.getByRole("heading", { level: 2, name: "No squad", exact: true })).toBeVisible();
    await groupBy("Conclusion");
    await expect(page).toHaveURL(/groupBy=conclusion/);
    await expect(gallery.getByRole("heading", { level: 2, name: "Proceed", exact: true })).toBeVisible();
    await expect(gallery.getByRole("heading", { level: 2, name: "Kill", exact: true })).toBeVisible();
    await expect(gallery.getByRole("heading", { level: 2, name: "No conclusion", exact: true })).toBeVisible();
    await groupBy("None");
    await expect(page).toHaveURL(/groupBy=none/);
    await expect(gallery.getByRole("heading", { level: 2 })).toHaveCount(0);
    await expect(card("shot")).toBeVisible();
    await groupBy("Status");
    await expect(page).not.toHaveURL(/groupBy=/);

    // Collapse a group hides its cards; expanding brings them back.
    await gallery.getByRole("button", { name: /^Running/ }).click();
    await expect(card("shot")).toBeHidden();
    await gallery.getByRole("button", { name: /^Running/ }).click();
    await expect(card("shot")).toBeVisible();

    // ── Squad filter works in the gallery ──────────────────────────────────────────────────────────
    await page.goto(`${base}/experiments?view=gallery&squad=${alpha}`);
    await expect(card("shot")).toBeVisible();
    await expect(card("pending")).toBeVisible();
    await expect(card("bare")).toHaveCount(0);
    await expect(card("killed")).toHaveCount(0);
    // View and filter survive a switch to Board and back.
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`squad=${alpha}`));
    await expect(page).not.toHaveURL(/view=gallery/);
    await page.getByRole("tab", { name: "Gallery", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`view=gallery.*squad=${alpha}|squad=${alpha}.*view=gallery`));
    // The legacy redirect keeps both.
    await page.goto(`${base}/experiments?view=gallery&squad=${alpha}&assumptionId=${randomUUID()}`);
    await expect(page).toHaveURL(/view=gallery/);
    await expect(page).toHaveURL(new RegExp(`squad=${alpha}`));
    await expect(page).toHaveURL(/detail=experiment-new/);

    // ── Card click opens the existing experiment panel ─────────────────────────────────────────────
    await page.goto(`${base}/experiments?view=gallery`);
    await card("bare").getByRole("button", { name: title("bare"), exact: true }).click();
    await expect(page).toHaveURL(/detail=experiment/);
    await expect(page).toHaveURL(/view=gallery/);
    await expect(page.getByRole("dialog").or(page.getByRole("complementary")).first()).toBeVisible();

    // ── Board <-> Gallery round trip keeps the dock layout ─────────────────────────────────────────
    await page.goto(`${base}/experiments?view=gallery`);
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    await expect(page).not.toHaveURL(/view=gallery/);
    await expect(page.getByTestId("board-pinned-region")).toBeVisible({ timeout: 30_000 });
    expect(JSON.parse((await page.evaluate((key) => window.localStorage.getItem(key), layoutKey))!)).toMatchObject({ pinnedColumnIds: ["KILLED"], activePinnedId: "KILLED", dockCollapsed: false });

    // ── Mobile ─────────────────────────────────────────────────────────────────────────────────────
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/experiments?view=gallery`);
    await expect(card("shot")).toBeVisible();
    expect(await noHorizontalOverflow()).toBe(true);
    // Single column: every card is as wide as the first.
    const widths = await gallery.locator('[data-testid="gallery-card"]').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeLessThanOrEqual(390);
    // Controls are reachable.
    await expect(page.getByRole("tab", { name: "Board", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Gallery", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Group gallery by" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Filters" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("experiments-gallery-mobile-390.png") });
    await page.getByRole("combobox", { name: "Group gallery by" }).click();
    await expect(page.getByRole("option", { name: "Conclusion", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await noHorizontalOverflow()).toBe(true);
  } finally {
    // The functional suite shares one workspace across specs in a run, so leave nothing behind.
    const like = `%${suffix}`;
    await pool.query(`DELETE FROM "${S}".entity_links WHERE link_type = 'ARTIFACT_ATTACHED_TO_EXPERIMENT' AND from_id IN (SELECT id FROM "${S}".artifacts WHERE title LIKE $1)`, [like]);
    await pool.query(`DELETE FROM "${S}".artifact_revisions WHERE artifact_id IN (SELECT id FROM "${S}".artifacts WHERE title LIKE $1)`, [like]);
    await pool.query(`DELETE FROM "${S}".artifacts WHERE title LIKE $1`, [like]);
    await pool.query(`DELETE FROM "${S}".experiments WHERE title LIKE $1`, [like]);
    await pool.query(`DELETE FROM "${S}".squads WHERE name LIKE $1`, [like]);
    await pool.end();
  }
});
