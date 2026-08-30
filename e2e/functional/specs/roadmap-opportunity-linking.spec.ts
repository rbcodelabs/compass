/**
 * Roadmap item opportunity-link editing.
 *
 * Journey: create an unlinked roadmap item → edit it to link the seeded
 * workspace opportunity → reload and confirm persistence → edit again to
 * clear the link → reload and confirm it remains unlinked.
 */
import { expect, test } from "../fixtures/index";

test.describe("Roadmap — opportunity links", () => {
  test("link, persist, and clear an opportunity from the edit dialog", async ({ page, base }) => {
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

    const dialog = page.getByRole("dialog", { name: "Edit roadmap item" });
    await expect(dialog.getByRole("combobox", { name: "Opportunity" })).toContainText(
      "— None —",
    );
    await dialog.getByRole("combobox", { name: "Opportunity" }).click();
    await page.getByRole("option", { name: opportunityTitle }).click();
    await dialog.getByRole("button", { name: "Save changes" }).click();

    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
    await expect(card.getByText(opportunityTitle, { exact: true })).toBeVisible();

    await page.reload();
    await page.waitForLoadState("networkidle");
    card = page.locator('[data-slot="card"]').filter({ hasText: title });
    await expect(card.getByText(opportunityTitle, { exact: true })).toBeVisible({ timeout: 10_000 });

    await card.hover();
    await card.getByLabel("Card actions").click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await expect(dialog.getByRole("combobox", { name: "Opportunity" })).toContainText(
      opportunityTitle,
    );
    await dialog.getByRole("combobox", { name: "Opportunity" }).click();
    await page.getByRole("option", { name: "— None —" }).click();
    await dialog.getByRole("button", { name: "Save changes" }).click();

    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
    await expect(card.getByText(opportunityTitle, { exact: true })).toHaveCount(0);

    await page.reload();
    await page.waitForLoadState("networkidle");
    card = page.locator('[data-slot="card"]').filter({ hasText: title });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText(opportunityTitle, { exact: true })).toHaveCount(0);
  });
});
