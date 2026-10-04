/**
 * Roadmap item opportunity-link editing.
 *
 * Journey: create an unlinked roadmap item → edit it in the detail panel to link the seeded
 * workspace opportunity → reload and confirm persistence → edit again to
 * clear the link → reload and confirm it remains unlinked.
 */
import type { Locator } from "@playwright/test";
import { expect, test } from "../fixtures/index";

// The reader's disclosure choice is remembered across opens, so open it only if shut.
async function openMoreProperties(panel: Locator) {
  const more = panel.getByRole("button", { name: "More properties" });
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
}

test.describe("Roadmap — opportunity links", () => {
  test("link, persist, and clear an opportunity from the detail panel", async ({ page, base }, testInfo) => {
    const title = `E2E Roadmap Opportunity Link ${Date.now()}`;
    const opportunityTitle = "E2E Baseline Opportunity";

    await page.goto(`${base}/roadmap`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Add item" }).first().click();
    await page.getByLabel("Title").fill(title);
    await page.getByRole("button", { name: "Add Item", exact: true }).click();

    let card = page.locator('[data-slot="card"]').filter({ hasText: title });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText(opportunityTitle, { exact: true })).toHaveCount(0);

    await card.hover();
    await card.getByLabel("Card actions").click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    const dialog = page.locator('[data-slot="sheet-content"]');
    await openMoreProperties(dialog);
    await expect(dialog.getByRole("combobox", { name: "Opportunity" })).toContainText(
      "— None —",
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({
      path: testInfo.outputPath("roadmap-opportunity-picker-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: testInfo.outputPath("roadmap-opportunity-picker-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await dialog.getByRole("combobox", { name: "Opportunity" }).click();
    await page.getByRole("option", { name: opportunityTitle }).click();
    await expect(card.getByText(opportunityTitle, { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.reload();
    await page.waitForLoadState("networkidle");
    card = page.locator('[data-slot="card"]').filter({ hasText: title });
    await expect(card.getByText(opportunityTitle, { exact: true })).toBeVisible({ timeout: 10_000 });

    await card.hover();
    await card.getByLabel("Card actions").click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await openMoreProperties(dialog);
    await expect(dialog.getByRole("combobox", { name: "Opportunity" })).toContainText(
      opportunityTitle,
    );
    await dialog.getByRole("combobox", { name: "Opportunity" }).click();
    await page.getByRole("option", { name: "— None —" }).click();
    await expect(card.getByText(opportunityTitle, { exact: true })).toHaveCount(0, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.reload();
    await page.waitForLoadState("networkidle");
    card = page.locator('[data-slot="card"]').filter({ hasText: title });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText(opportunityTitle, { exact: true })).toHaveCount(0);
  });
});
