/**
 * OKRs functional spec.
 *
 * Journey: Create cycle → navigate in → add objective → add key result
 *          → log check-in → change objective status.
 *
 * Each test run uses a unique title (via timestamp) so parallel runs or
 * retries don't collide with each other.
 */
import { test, expect } from "../fixtures/index";

test.describe("OKRs", () => {
  test("create cycle → objective → KR → check-in → status change", async ({
    page,
    base,
  }) => {
    const ts = Date.now();
    const cycleTitle = `E2E Cycle ${ts}`;
    const objectiveTitle = `E2E Objective ${ts}`;
    const krTitle = `E2E KR ${ts}`;

    // ── 1. Navigate to OKRs ──────────────────────────────────────────────────
    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");

    // ── 2. Create a new cycle ────────────────────────────────────────────────
    await page.getByRole("button", { name: "New Cycle" }).click();
    await page.getByLabel("Title").fill(cycleTitle);
    await page.getByLabel("Start date").fill("2026-07-01");
    await page.getByLabel("End date").fill("2026-09-30");
    await page.getByRole("button", { name: "Create cycle" }).click();

    // Cycle card visible on the list page
    await expect(page.getByText(cycleTitle)).toBeVisible({ timeout: 15_000 });

    // ── 3. Open the cycle ────────────────────────────────────────────────────
    await page.getByText(cycleTitle).click();
    await page.waitForLoadState("networkidle");
    // Confirm we're on the cycle detail page
    await expect(page.getByRole("heading", { name: cycleTitle })).toBeVisible();

    // ── 4. Add an objective ──────────────────────────────────────────────────
    await page.getByRole("button", { name: /Add objective/i }).click();
    await page.getByLabel("Title").fill(objectiveTitle);
    await page.getByRole("button", { name: "Add objective" }).click();

    // Objective title appears in the list
    await expect(page.getByText(objectiveTitle)).toBeVisible({ timeout: 10_000 });

    // ── 5. Add a key result ──────────────────────────────────────────────────
    await page.getByRole("button", { name: /Add key result/i }).click();
    await page.getByLabel("Title").fill(krTitle);
    await page.getByLabel("Target").fill("100");
    await page.getByLabel("Unit (optional)").fill("%");
    await page.getByRole("button", { name: "Add key result" }).click();

    // KR title appears in the row
    await expect(page.getByText(krTitle)).toBeVisible({ timeout: 10_000 });

    // ── 6. Log a check-in ───────────────────────────────────────────────────
    // KR bar shows initial progress "0 % / 100 %"
    await expect(page.getByText("0 % / 100 %")).toBeVisible();

    await page.getByRole("button", { name: "Check in" }).click();
    // Clear current value (pre-filled with 0) and enter 50
    await page.getByLabel("Current value").fill("50");
    await page.getByRole("button", { name: "Save check-in" }).click();

    // After check-in, KR bar reflects new value
    await expect(page.getByText("50 % / 100 %")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("50%")).toBeVisible();

    // ── 7. Change objective status to AT_RISK ───────────────────────────────
    // The status badge trigger shows "On track" (default); clicking it opens the Select
    await page.getByText("On track").click();
    await page.getByRole("option", { name: "At risk" }).click();

    // Badge now shows "At risk"
    await expect(page.getByText("At risk")).toBeVisible({ timeout: 10_000 });
  });
});
