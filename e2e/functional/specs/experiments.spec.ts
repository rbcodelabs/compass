/**
 * Experiments functional spec.
 *
 * Journey: Create experiment (DESIGNING) → open panel and full detail →
 *          start experiment (→ RUNNING) → log result →
 *          conclude as Proceed (→ COMPLETE).
 */
import { test, expect } from "../fixtures/index";

test.describe("Experiments", () => {
  test(
    "create → start → log result → conclude as Proceed",
    async ({ page, base }) => {
      const ts = Date.now();
      const expTitle = `E2E Experiment ${ts}`;

      // ── 1. Navigate to Experiments board ──────────────────────────────────
      await page.goto(`${base}/experiments`);
      await page.waitForLoadState("networkidle");

      // ── 2. Create a new experiment ────────────────────────────────────────
      await page.getByRole("button", { name: "New Experiment" }).click();
      await page.getByLabel("Title").fill(expTitle);
      await page.getByLabel("Hypothesis").fill("We believe that this will work.");
      await page.getByLabel("Method").fill("A/B test with equal split.");
      await page.getByLabel("Kill Condition").fill(
        "Stop if fewer than 10% of users engage after 14 days."
      );
      await page.getByRole("button", { name: "Create Experiment" }).click();

      // Experiment card appears in DESIGNING column
      await expect(page.getByText(expTitle)).toBeVisible({ timeout: 15_000 });

      // ── 3. Open the panel, then continue to the full detail page ──────────
      await page.getByRole("button", { name: expTitle }).click();
      await expect(page).toHaveURL(/detail=experiment/);
      await page.getByRole("link", { name: "Open full page" }).click();

      // Confirm we're on the detail page
      await expect(page.getByRole("heading", { name: expTitle })).toBeVisible();
      // Status badge should show "Designing".
      // Use .first() to avoid strict-mode collision with Next.js dev-mode
      // hydration error overlay which also contains the word "Designing".
      await expect(page.getByText("Designing").first()).toBeVisible();

      // ── 4. Start the experiment ───────────────────────────────────────────
      await page.getByRole("button", { name: "Start Experiment" }).click();

      // Status badge should update to "Running"
      await expect(page.getByText("Running")).toBeVisible({ timeout: 10_000 });

      // Kill condition banner should be visible (appears when experiment is active)
      await expect(
        page.getByText("Stop if fewer than 10% of users engage after 14 days.")
      ).toBeVisible();

      // ── 5. Log a result ───────────────────────────────────────────────────
      await page.getByRole("button", { name: "Log Result" }).click();
      await page.getByLabel("Note").fill("Positive signal observed — 23% engagement.");
      await page.getByRole("button", { name: "Log Result" }).last().click();

      // Result note appears in the results section
      await expect(
        page.getByText("Positive signal observed — 23% engagement.")
      ).toBeVisible({ timeout: 10_000 });

      // ── 6. Conclude the experiment as Proceed ─────────────────────────────
      await page.getByRole("button", { name: "Conclude Experiment" }).click();

      // Select the Proceed conclusion card
      await page.getByRole("button", { name: "Proceed" }).click();

      // The conclude button changes to "Conclude as Proceed"
      await page.getByRole("button", { name: "Conclude as Proceed" }).click();

      // Status badge updates to "Complete"
      await expect(page.getByText("Complete")).toBeVisible({ timeout: 10_000 });

      // Conclusion badge "Proceed" also appears
      await expect(page.getByText("Proceed")).toBeVisible();
    }
  );
});
