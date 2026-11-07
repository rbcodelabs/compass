/**
 * Journey: the Discovery board shows the Unreviewed inbox as its last column;
 * hovering a column's info icon explains the status; a new opportunity created
 * from the board lands in Unreviewed and its status dropdown lists every status.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/index";
import { createOpportunityFromBoard } from "../fixtures/opportunity-composer";

/** Board columns, in render order, read from each column's info button. */
async function expectColumnOrder(page: Page) {
  const order = await page
    .getByRole("button", { name: /^About the .* status$/ })
    .evaluateAll((els) => els.map((el) => (el.getAttribute("aria-label") ?? "").replace(/^About the | status$/g, "")));
  expect(order).toEqual(["Active", "Prioritized", "Validating", "Exploring", "Unreviewed"]);
}

test.describe("Opportunity statuses", () => {
  test("Unreviewed is the last column, explains itself, and is the default for new opportunities", async ({ page, base }) => {
    const title = `E2E Unreviewed ${Date.now()}`;
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");

    await expectColumnOrder(page);

    // Hovering the info icon states the definition and the entry criterion.
    await page.getByRole("button", { name: "About the Unreviewed status" }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "About the Unreviewed status" }).hover();
    await expect(page.getByText("nobody has triaged it yet", { exact: false })).toBeVisible();
    await expect(page.getByText("Enter when:", { exact: false })).toBeVisible();
    await page.screenshot({ path: "test-results/unreviewed-board-tooltip.png" });

    // The first column's "Add opportunity" presets that column's status (Active), not Unreviewed.
    await page.getByRole("button", { name: /Add opportunity/i }).first().click();
    await expect(
      page.locator('[data-slot="opportunity-composer"]').getByRole("combobox", { name: "Status" }),
    ).toHaveText(/Active/);

    // The Unreviewed column's own "Add opportunity" presets Unreviewed.
    const id = await createOpportunityFromBoard(page, title, { column: "Unreviewed" });
    const unreviewed = page.getByRole("heading", { level: 3, name: /^Unreviewed/ }).locator("xpath=ancestor::section[1]");
    await expect(unreviewed.getByText(title)).toBeVisible({ timeout: 15_000 });

    // The opportunity's own status control reads Unreviewed and offers the whole pipeline.
    await page.goto(`${base}/discovery/${id}`);
    await page.waitForLoadState("networkidle");
    const status = page.getByRole("combobox").filter({ hasText: "Unreviewed" }).first();
    await expect(status).toBeVisible();
    await status.click();
    for (const label of ["Unreviewed", "Exploring", "Validating", "Prioritized", "Active", "Archived"]) {
      await expect(page.getByRole("option", { name: label })).toBeVisible();
    }
  });

  test("mobile: the Unreviewed column leads the board and its info hint opens", async ({ page, base }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await expectColumnOrder(page);
    await page.getByRole("button", { name: "About the Unreviewed status" }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "About the Unreviewed status" }).focus();
    await expect(page.getByText("nobody has triaged it yet", { exact: false })).toBeVisible();
    await page.screenshot({ path: "test-results/unreviewed-board-mobile.png" });
  });
});
