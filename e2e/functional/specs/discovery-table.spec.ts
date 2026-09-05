import { test, expect } from "../fixtures/index";

test.describe("Discovery table", () => {
  test("switches views, expands solutions, and opens both detail panels", async ({ page, base }) => {
    const timestamp = Date.now();
    const opportunityTitle = `E2E Table Opportunity ${timestamp}`;
    const solutionTitle = `E2E Table Solution ${timestamp}`;

    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /Add opportunity/i }).first().click();
    await page.getByLabel("Title").fill(opportunityTitle);
    await page.getByRole("button", { name: "Create Opportunity" }).click();
    await expect(page.getByRole("button", { name: opportunityTitle, exact: true })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: opportunityTitle, exact: true }).click();
    const panel = page.locator('[data-slot="sheet-content"]');
    await panel.getByRole("button", { name: "Add Solution" }).click();
    await panel.getByLabel("Title").fill(solutionTitle);
    await panel.getByRole("button", { name: "Add Solution" }).click();
    await expect(panel.getByText(solutionTitle)).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");

    await page.getByRole("tab", { name: "Table" }).click();
    await expect(page).toHaveURL(/view=table/);
    await expect(page.getByRole("table", { name: "Discovery opportunities" })).toBeVisible();

    const expand = page.getByRole("button", { name: `Expand ${opportunityTitle}` });
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expand.click();
    await expect(expand).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: solutionTitle, exact: true })).toBeVisible();

    await page.getByRole("button", { name: opportunityTitle, exact: true }).click();
    await expect(page).toHaveURL(/detail=opportunity/);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: solutionTitle, exact: true }).click();
    await expect(page).toHaveURL(/detail=solution/);
  });

  test.describe("mobile", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("keeps the table horizontally scrollable", async ({ page, base }) => {
      await page.goto(`${base}/discovery?view=table`);
      await page.waitForLoadState("networkidle");

      const tableContainer = page.locator('[data-slot="table-container"]');
      await expect(tableContainer).toBeVisible();
      await expect(tableContainer).toHaveCSS("overflow-x", "auto");
    });
  });
});
