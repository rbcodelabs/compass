/**
 * Roadmap decision functional spec.
 *
 * The fixture supplies a NEXT candidate plus independently verifiable,
 * already-applied Building-investment authority and an active capacity plan.
 * Decisions now record a human call without automatically moving linked work.
 */
import { test, expect } from "../fixtures/index";
import { E2E_NOW_CANDIDATE_TITLE } from "../fixtures/seed-e2e";

test.describe("Roadmap decision and NOW commitment", () => {
  test("admin records a linked decision, then explicitly moves the candidate to NOW", async ({ page, base }) => {
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
      .getByRole("link", { name: "Request decision", exact: true })
      .click();
    await expect(page).toHaveURL(/\/decisions\/new\?subjectType=ROADMAP_ITEM/);
    await expect(page.getByRole("combobox", { name: "Link to", exact: true })).toHaveValue("ROADMAP_ITEM");
    await expect(page.getByRole("combobox", { name: "Item", exact: true }).locator("option:checked")).toHaveText(E2E_NOW_CANDIDATE_TITLE);
    const question = `Commit ${E2E_NOW_CANDIDATE_TITLE} to NOW?`;
    await page.getByLabel("Decision question").fill(question);
    await page.getByRole("textbox", { name: /^Context/ }).fill("Capacity is available; record the decision before scheduling delivery.");
    await page.getByRole("button", { name: "Request decision", exact: true }).click();
    await expect(page).toHaveURL(/\/reviews\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole("heading", { name: question })
    ).toBeVisible();
    const qaScreenshotDir = process.env.NOW_GATE_QA_SCREENSHOT_DIR;
    if (qaScreenshotDir) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.screenshot({ path: `${qaScreenshotDir}/desktop.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `${qaScreenshotDir}/mobile.png`, fullPage: true });
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(
      page.getByText(/Decision recorded:.*Approve/)
    ).toBeVisible({ timeout: 15_000 });

    // Generic approval records the decision without silently moving the item.
    await page.goto(`${base}/roadmap`);
    await page.waitForLoadState("networkidle");
    await expect(candidate).toBeVisible({ timeout: 10_000 });
    await candidate.click();
    await candidatePanel.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Now", exact: true }).click();
    await expect(candidatePanel.getByRole("combobox").first()).toContainText("Now");
    await page.goto(`${base}/roadmap`);
    const nowColumn = page.locator("#roadmap-column-NOW");
    const admitted = nowColumn.getByRole("button", {
      name: E2E_NOW_CANDIDATE_TITLE,
      exact: true,
    });
    await expect(admitted).toBeVisible({ timeout: 10_000 });
  });
});
