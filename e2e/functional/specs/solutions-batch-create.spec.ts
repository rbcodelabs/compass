/**
 * "Add solutions" in the data grid (sheet mode): the parent Opportunity is chosen once per batch.
 *
 * Journeys:
 *  1. Solutions backlog table: pick a parent, paste rows, Create -> rows appear in the backlog under
 *     that parent and persist after a reload.
 *  2. Discovery table: the "Add solution to ..." button on an opportunity row switches the draft
 *     area to Add solutions with that parent preselected; the new solutions show when the row is expanded.
 *  3. A pasted Opportunity title that matches nothing is an inline error on that row; the other rows still create.
 *
 * Pastes are synthetic `ClipboardEvent("paste")`s (no clipboard permission needed), like discovery-batch-create.spec.ts.
 */
import { test, expect } from "../fixtures/index";
import { createOpportunityFromBoard } from "../fixtures/opportunity-composer";
import type { Page } from "@playwright/test";

async function pasteIntoBlankRow(page: Page, text: string) {
  await page.evaluate((clipboardText) => {
    const inputs = document.querySelectorAll<HTMLInputElement>('[data-testid="grid-draft-area"] input[aria-label^="Title for"]');
    const target = inputs[inputs.length - 1];
    target.focus();
    const data = new DataTransfer();
    data.setData("text/plain", clipboardText);
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

const draftRows = (page: Page) => page.getByTestId("draft-row");

async function createOpportunity(page: Page, base: string, title: string) {
  await page.goto(`${base}/discovery`);
  await page.waitForLoadState("networkidle");
  await createOpportunityFromBoard(page, title);
  await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible({ timeout: 15_000 });
}

test.describe("Solutions batch create", () => {
  test("creates pasted solutions under the chosen opportunity from the Solutions table", async ({ page, base }) => {
    const ts = Date.now();
    const parent = `E2E Solutions Parent ${ts}`;
    const token = `E2E Batch Solution ${ts}`;
    await createOpportunity(page, base, parent);

    await page.goto(`${base}/solutions?view=table`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("grid-draft-area")).toBeVisible();

    await page.getByTestId("draft-parent").selectOption({ label: parent });
    await pasteIntoBlankRow(page, `${token} 1\n${token} 2\t\tSecond description\n${token} 3\n`);
    await expect(draftRows(page)).toHaveCount(3);
    await expect(page.getByTestId("draft-create")).toHaveText("Create 3");
    await page.getByTestId("draft-create").click();

    await expect(draftRows(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("draft-summary")).toContainText("Created 3");
    const created = page.locator("[data-row-id]").filter({ hasText: token });
    await expect(created).toHaveCount(3, { timeout: 15_000 });
    await expect(created.first().getByRole("link", { name: parent, exact: true })).toBeVisible();

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-row-id]").filter({ hasText: token })).toHaveCount(3);
  });

  test("Add solution on a Discovery row preselects its parent, and the solutions show when expanded", async ({ page, base }) => {
    const ts = Date.now();
    const parent = `E2E Row Parent ${ts}`;
    const token = `E2E Row Solution ${ts}`;
    await createOpportunity(page, base, parent);

    await page.goto(`${base}/discovery?view=table`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: `Add solution to ${parent}` }).click();
    await expect(page.getByTestId("draft-mode-solutions")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("draft-parent").locator("option:checked")).toHaveText(parent);

    await pasteIntoBlankRow(page, `${token} A\n${token} B\n`);
    await expect(draftRows(page)).toHaveCount(2);
    await page.getByTestId("draft-create").click();
    await expect(draftRows(page)).toHaveCount(0, { timeout: 30_000 });

    await page.getByRole("button", { name: `Expand ${parent}` }).click({ timeout: 15_000 });
    await expect(page.locator('[data-row-id^="solution:"]').filter({ hasText: token })).toHaveCount(2);
  });

  test("an unknown pasted Opportunity title fails on its own row while the others are created", async ({ page, base }) => {
    const ts = Date.now();
    const parent = `E2E Match Parent ${ts}`;
    const token = `E2E Match Solution ${ts}`;
    await createOpportunity(page, base, parent);

    await page.goto(`${base}/solutions?view=table`);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("draft-parent").selectOption({ label: parent });
    await pasteIntoBlankRow(page, `${token} ok\n${token} bad\tNo such opportunity ${ts}\n`);
    await page.getByTestId("draft-create").click();

    await expect(page.getByTestId("draft-field-error")).toContainText("No opportunity titled");
    await expect(draftRows(page)).toHaveCount(1);
    await expect(page.locator("[data-row-id]").filter({ hasText: `${token} ok` })).toHaveCount(1, { timeout: 15_000 });
  });
});
