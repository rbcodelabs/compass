/**
 * Scoring Models functional spec.
 *
 * Journey: Org Settings → create a WEIGHTED_SUM scoring model with two
 *          metrics (Reach +, Effort -) → Workspace Settings → activate that
 *          model for the workspace → open the seeded baseline opportunity →
 *          the Scoring tab appears → enter raw values → save → verify the
 *          computed normalized score persists across a reload.
 *
 * The seeded e2e user (dev@localhost.dev) is both an organization ADMIN and
 * a workspace ADMIN (see e2e/functional/fixtures/seed-e2e.ts), so this
 * single spec can exercise the full org-author → workspace-select →
 * member-score flow without needing multiple test users.
 *
 * Metric row inputs share label text across rows ("Key", "Label", "Min",
 * "Max", "Weight", "Direction" repeat once per metric), so this spec
 * targets them by the deterministic per-row element IDs
 * (`create-metric-<index>-<field>`) rather than getByLabel, which would be
 * ambiguous with more than one metric row on the page.
 */
import { test, expect } from "../fixtures/index";

test.describe("Scoring Models", () => {
  test(
    "create scoring model → activate for workspace → score an opportunity",
    async ({ page, base, orgSlug }) => {
      const ts = Date.now();
      const modelName = `E2E RICE ${ts}`;

      // ── 1. Create a scoring model in Org Settings ─────────────────────────
      await page.goto(`/${orgSlug}/settings`);
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: "Add scoring model" }).click();
      await page.getByLabel("Name").fill(modelName);
      // Formula Type defaults to Weighted Sum — leave as-is.

      // First metric row (pre-populated by the form): Reach, POSITIVE.
      await page.locator("#create-metric-0-key").fill("reach");
      await page.locator("#create-metric-0-label").fill("Reach");
      await page.locator("#create-metric-0-min").fill("0");
      await page.locator("#create-metric-0-max").fill("10");
      await page.locator("#create-metric-0-weight").fill("1");
      // Direction already defaults to Positive.

      // Second metric row: Effort, NEGATIVE.
      await page.getByRole("button", { name: "Add metric" }).click();
      await page.locator("#create-metric-1-key").fill("effort");
      await page.locator("#create-metric-1-label").fill("Effort");
      await page.locator("#create-metric-1-min").fill("0");
      await page.locator("#create-metric-1-max").fill("10");
      await page.locator("#create-metric-1-weight").fill("1");
      await page.locator("#create-metric-1-direction").click();
      await page.getByRole("option", { name: "Negative" }).click();

      await page.getByRole("button", { name: "Create Scoring Model" }).click();

      // New model row appears in the list.
      await expect(page.getByText(modelName)).toBeVisible({ timeout: 15_000 });

      // Confirm it persisted server-side.
      await page.reload();
      await page.waitForLoadState("load");
      await expect(page.getByText(modelName)).toBeVisible({ timeout: 10_000 });

      // ── 2. Activate the model for the workspace ────────────────────────────
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");

      await page.getByLabel("Active scoring model").click();
      await page.getByRole("option", { name: modelName }).click();

      // No explicit saving indicator for this select — give the server
      // action a moment, then reload to verify persistence.
      await page.waitForTimeout(1_500);
      await page.reload();
      await page.waitForLoadState("load");
      await expect(page.getByLabel("Active scoring model")).toContainText(modelName, {
        timeout: 10_000,
      });

      // ── 3. Score the seeded baseline opportunity ────────────────────────────
      await page.goto(`${base}/discovery`);
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: "E2E Baseline Opportunity", exact: true }).click();
      await page.getByRole("link", { name: "Open full page" }).click();
      await page.waitForLoadState("networkidle");

      await page.getByRole("tab", { name: "Scoring" }).click();

      await expect(page.getByText(modelName)).toBeVisible();

      const reachInput = page.getByLabel("Reach");
      const effortInput = page.getByLabel("Effort");
      await reachInput.fill("8");
      await effortInput.fill("2");

      // Live preview updates before saving: rawScore = 8 - 2 = 6.
      await expect(page.getByText(/Raw score: 6\.00/)).toBeVisible();

      await page.getByRole("button", { name: "Save Score" }).click();

      // "Last saved" panel appears once the server action resolves.
      await expect(page.getByText("Last saved")).toBeVisible({ timeout: 15_000 });

      // ── 4. Verify the score persisted across a reload ───────────────────────
      await page.reload();
      await page.waitForLoadState("load");
      await page.getByRole("tab", { name: "Scoring" }).click();

      await expect(page.getByLabel("Reach")).toHaveValue("8");
      await expect(page.getByLabel("Effort")).toHaveValue("2");
      await expect(page.getByRole("button", { name: "Update Score" })).toBeVisible();
    }
  );
});
