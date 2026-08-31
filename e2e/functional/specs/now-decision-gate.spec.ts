/**
 * Native NOW decision gate functional spec.
 *
 * The fixture supplies a NEXT candidate plus independently verifiable,
 * already-applied Building-investment authority and an active capacity plan.
 * This test starts at the user boundary: request an immutable review, take the
 * human decision, and verify admission provenance and its durable receipt.
 */
import { test, expect } from "../fixtures/index";
import { E2E_NOW_CANDIDATE_TITLE } from "../fixtures/seed-e2e";

test.describe("Native NOW decision gate", () => {
  test("admin requests, decides, and applies a NOW commitment with durable provenance", async ({ page, base }) => {
    // Arrange: the policy-backed candidate begins in NEXT.
    await page.goto(`${base}/roadmap`);
    await page.waitForLoadState("networkidle");
    const nextColumn = page.locator("#roadmap-column-NEXT");
    const candidate = nextColumn.getByRole("button", {
      name: E2E_NOW_CANDIDATE_TITLE,
      exact: true,
    });
    await expect(candidate).toBeVisible({ timeout: 10_000 });
    await candidate.click();

    // Act: request the real server-side review, then take the admin decision.
    const candidatePanel = page.locator('[data-slot="sheet-content"]');
    await candidatePanel
      .getByRole("button", { name: "Request NOW commitment" })
      .click();
    await expect(page).toHaveURL(/\/reviews\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole("heading", { name: E2E_NOW_CANDIDATE_TITLE })
    ).toBeVisible();
    const qaScreenshotDir = process.env.NOW_GATE_QA_SCREENSHOT_DIR;
    if (qaScreenshotDir) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.screenshot({ path: `${qaScreenshotDir}/desktop.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `${qaScreenshotDir}/mobile.png`, fullPage: true });
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await page.getByRole("button", { name: "Commit to NOW" }).click();
    await expect(
      page.getByText(/Decision recorded:.*Commit to NOW/)
    ).toBeVisible({ timeout: 15_000 });

    // Assert: the guarded continuation moved the item and left navigable
    // decision provenance plus an APPLIED, durable application receipt.
    await page.goto(`${base}/roadmap`);
    await page.waitForLoadState("networkidle");
    const nowColumn = page.locator("#roadmap-column-NOW");
    const admitted = nowColumn.getByRole("button", {
      name: E2E_NOW_CANDIDATE_TITLE,
      exact: true,
    });
    await expect(admitted).toBeVisible({ timeout: 10_000 });
    await admitted.click();
    const admittedPanel = page.locator('[data-slot="sheet-content"]');
    await expect(admittedPanel.getByText(/native decision provenance/i)).toBeVisible();
    const decisionLink = admittedPanel.getByRole("link", { name: /Decision record:/ });
    await expect(decisionLink).toBeVisible();
    await expect(decisionLink).toHaveAttribute("href", /\/reviews\/[0-9a-f-]{36}$/);
    await expect(
      admittedPanel.getByText(/Application receipt:.*\(APPLIED\)/)
    ).toBeVisible();
  });
});
