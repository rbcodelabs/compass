/**
 * Journey: the Discovery board opens with an Unreviewed inbox column first;
 * hovering a column's info icon explains the status; a new opportunity created
 * from the board lands in Unreviewed and its status dropdown lists every status.
 */
import { expect, test } from "../fixtures/index";
import { createOpportunityFromBoard } from "../fixtures/opportunity-composer";

test.describe("Opportunity statuses", () => {
  test("Unreviewed is the first column, explains itself, and is the default for new opportunities", async ({ page, base }) => {
    const title = `E2E Unreviewed ${Date.now()}`;
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");

    const titles = page.getByRole("heading", { level: 3 });
    await expect(titles.first()).toHaveText(/^Unreviewed/);

    // Hovering the info icon states the definition and the entry criterion.
    await page.getByRole("button", { name: "About the Unreviewed status" }).hover();
    await expect(page.getByText("nobody has triaged it yet", { exact: false })).toBeVisible();
    await expect(page.getByText("Enter when:", { exact: false })).toBeVisible();
    await page.screenshot({ path: "test-results/unreviewed-board-tooltip.png" });

    // First column's "Add opportunity" presets Unreviewed, and so does a fresh composer.
    const id = await createOpportunityFromBoard(page, title);
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
    await expect(page.getByRole("heading", { level: 3 }).first()).toHaveText(/^Unreviewed/);
    await page.getByRole("button", { name: "About the Unreviewed status" }).focus();
    await expect(page.getByText("nobody has triaged it yet", { exact: false })).toBeVisible();
    await page.screenshot({ path: "test-results/unreviewed-board-mobile.png" });
  });
});
