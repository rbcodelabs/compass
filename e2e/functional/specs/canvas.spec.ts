/**
 * Canvas functional spec.
 *
 * Journey: create a cycle with two Objectives (each with a Key Result) via
 * the existing /okrs UI — seed-e2e.ts seeds no Objectives/KRs, so these are
 * created inline through the app's own mutation path, mirroring
 * okrs.spec.ts's Date.now()-suffixed-title pattern so parallel runs/retries
 * don't collide — then navigate to /canvas and verify it renders both
 * Objectives and both KRs, and that pan + zoom both work with zero console
 * errors.
 *
 * Explicitly not tested: focus nav, drag-to-pin persistence, semantic zoom
 * tiers, multi-parent edges — none of that ships in Phase 1.
 */
import { test, expect } from "../fixtures/index";

test.describe("Canvas", () => {
  test("renders seeded Objectives/KRs and supports pan + zoom", async ({
    page,
    base,
  }) => {
    const ts = Date.now();
    const cycleTitle = `Canvas E2E Cycle ${ts}`;
    const objectiveATitle = `Canvas E2E Objective A ${ts}`;
    const objectiveBTitle = `Canvas E2E Objective B ${ts}`;
    const krATitle = `Canvas E2E KR A ${ts}`;
    const krBTitle = `Canvas E2E KR B ${ts}`;

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(err.message));

    // ── 1. Create a cycle ────────────────────────────────────────────────
    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New Cycle" }).click();
    await page.getByLabel("Title").fill(cycleTitle);
    await page.getByLabel("Start date").fill("2026-07-01");
    await page.getByLabel("End date").fill("2026-09-30");
    await page.getByRole("button", { name: "Create cycle" }).click();
    await expect(page.getByText(cycleTitle)).toBeVisible({ timeout: 15_000 });

    // ── 2. Open the cycle, add two Objectives ───────────────────────────────
    await page.getByText(cycleTitle).click();
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByRole("heading", { name: cycleTitle })
    ).toBeVisible();

    for (const objTitle of [objectiveATitle, objectiveBTitle]) {
      await page.getByRole("button", { name: /Add objective/i }).click();
      await page.getByLabel("Title").fill(objTitle);
      await page.getByRole("button", { name: "Add objective" }).click();
      await expect(page.getByText(objTitle)).toBeVisible({ timeout: 10_000 });
    }

    // ── 3. Add a Key Result to each Objective ───────────────────────────────
    // Each Objective row has its own "Add key result" trigger, so scope the
    // locator to the specific row (identified by its title text) rather than
    // relying on there being only one on the page.
    for (const [objTitle, krTitle] of [
      [objectiveATitle, krATitle],
      [objectiveBTitle, krBTitle],
    ] as const) {
      const row = page
        .locator(".rounded-xl.border")
        .filter({ hasText: objTitle });
      await row.getByRole("button", { name: /Add key result/i }).click();
      await row.getByLabel("Title").fill(krTitle);
      await row.getByLabel("Target").fill("100");
      await row.getByLabel("Unit (optional)").fill("%");
      await row.getByRole("button", { name: "Add key result" }).click();
      // Form closes once the server action completes.
      await expect(row.getByLabel("Target")).not.toBeVisible({
        timeout: 20_000,
      });
    }

    // ── 4. Navigate to Canvas ────────────────────────────────────────────────
    await page.goto(`${base}/canvas`);
    await page.waitForLoadState("networkidle");

    // Canvas root renders without error.
    await expect(page.locator(".react-flow")).toBeVisible({
      timeout: 15_000,
    });

    // Both Objective titles are visible.
    await expect(page.getByText(objectiveATitle)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(objectiveBTitle)).toBeVisible();

    // Both KR progress rows are visible. KeyResultNode renders
    // "{current}{unit} / {target}{unit}" with a leading space before a
    // present unit (matching key-result-bar.tsx's exact format) — a fresh,
    // un-checked-in KR with target 100 and unit "%" reads "0 % / 100 %".
    await expect(page.getByText(krATitle)).toBeVisible();
    await expect(page.getByText(krBTitle)).toBeVisible();
    await expect(page.getByText("0 % / 100 %").first()).toBeVisible();

    // ── 5. Pan: drag on the pane, content survives the transform ────────────
    const pane = page.locator(".react-flow__pane");
    const paneBox = await pane.boundingBox();
    if (!paneBox) throw new Error("Canvas pane did not render a bounding box");

    await page.mouse.move(
      paneBox.x + paneBox.width / 2,
      paneBox.y + paneBox.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      paneBox.x + paneBox.width / 2 - 150,
      paneBox.y + paneBox.height / 2 - 100,
      { steps: 10 }
    );
    await page.mouse.up();

    // ── 6. Zoom: use the built-in zoom controls ─────────────────────────────
    await page.locator(".react-flow__controls-zoomin").click();
    await page.locator(".react-flow__controls-zoomin").click();
    await page.locator(".react-flow__controls-zoomout").click();

    // Content survives pan + zoom.
    await expect(page.getByText(objectiveATitle)).toBeVisible();
    await expect(page.getByText(objectiveBTitle)).toBeVisible();

    // Zero console errors across the whole journey.
    expect(consoleErrors).toEqual([]);
  });
});
