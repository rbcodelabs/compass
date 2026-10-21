/**
 * Draft-row creation in the Discovery table (sheet mode, Opportunities "add" mode).
 *
 * The paste is a synthetic `ClipboardEvent("paste")` carrying a `DataTransfer`, which needs no
 * clipboard permission and behaves the same in every browser. The text is what Google Sheets puts
 * on the clipboard: tab-separated, quoted cells, CRLF row ends and a trailing newline.
 *
 * Journeys: paste 20 rows -> 20 drafts -> Create 20 -> 20 opportunities, persisted after reload;
 * one over-long title fails inline while the rest are created; a response lost after the server
 * wrote the rows -> retry resends the same ids -> exactly N rows (no duplicates).
 */
import { test, expect } from "../fixtures/index";
import type { Page } from "@playwright/test";

/** Builds Google-Sheets-style clipboard text: quoted cells, CRLF, trailing newline. */
function sheetsText(rows: string[][]): string {
  const quote = (cell: string) => (/["\t\r\n,]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
  return rows.map((row) => row.map(quote).join("\t")).join("\r\n") + "\r\n";
}

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
const tableRows = (page: Page, token: string) =>
  page.locator('[data-row-id^="opportunity:"]').filter({ hasText: token });

test.describe("Discovery batch create", () => {
  test("pasting a spreadsheet creates every row, and they persist", async ({ page, base }) => {
    const token = `E2E Batch ${Date.now()}`;
    await page.goto(`${base}/discovery?view=table`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("grid-draft-area")).toBeVisible();

    const rows = Array.from({ length: 20 }, (_, index) => [
      index === 3 ? `${token} ${index}, with "quotes"` : `${token} ${index}`,
      "New teams",
      "Exploring",
      "",
      index === 5 ? "Line one\nLine two" : `Description ${index}`,
    ]);
    await pasteIntoBlankRow(page, sheetsText(rows));

    await expect(draftRows(page)).toHaveCount(20);
    await expect(page.getByTestId("draft-create")).toHaveText("Create 20");
    await expect(page.getByLabel("Title for opportunity draft 4")).toHaveValue(`${token} 3, with "quotes"`);

    await page.getByTestId("draft-create").click();
    await expect(draftRows(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("draft-summary")).toContainText("Created 20");
    await expect(tableRows(page, token)).toHaveCount(20, { timeout: 15_000 });

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(tableRows(page, token)).toHaveCount(20);
  });

  test("a failing row shows its error inline while the others are created", async ({ page, base }) => {
    const token = `E2E Partial ${Date.now()}`;
    await page.goto(`${base}/discovery?view=table`);
    await page.waitForLoadState("networkidle");

    await pasteIntoBlankRow(
      page,
      sheetsText([[`${token} good 1`], ["x".repeat(300)], [`${token} good 2`]]),
    );
    await expect(draftRows(page)).toHaveCount(3);
    await page.getByTestId("draft-create").click();

    await expect(tableRows(page, token)).toHaveCount(2, { timeout: 15_000 });
    await expect(draftRows(page)).toHaveCount(1);
    await expect(page.getByTestId("draft-field-error")).toContainText("255 characters");
    await expect(page.getByLabel("Title for opportunity draft 1")).toHaveAttribute("aria-invalid", "true");

    // Fix the title and resubmit: the failed draft is editable and creates normally.
    await page.getByLabel("Title for opportunity draft 1").fill(`${token} fixed`);
    await page.getByTestId("draft-create").click();
    await expect(draftRows(page)).toHaveCount(0, { timeout: 15_000 });
    await expect(tableRows(page, token)).toHaveCount(3, { timeout: 15_000 });
  });

  test("a lost response followed by a retry creates exactly N rows", async ({ page, base }) => {
    const token = `E2E Retry ${Date.now()}`;
    await page.goto(`${base}/discovery?view=table`);
    await page.waitForLoadState("networkidle");

    // Let the server do the work, then drop the response: the client cannot know whether it was written.
    let dropped = false;
    await page.route("**/discovery**", async (route) => {
      const request = route.request();
      if (!dropped && request.method() === "POST" && request.headers()["next-action"]) {
        dropped = true;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await pasteIntoBlankRow(page, sheetsText([1, 2, 3, 4, 5].map((n) => [`${token} ${n}`])));
    await expect(draftRows(page)).toHaveCount(5);
    await page.getByTestId("draft-create").click();
    await expect(page.getByTestId("draft-row-error").first()).toContainText("Retry is safe", { timeout: 15_000 });
    await expect(draftRows(page)).toHaveCount(5);
    expect(dropped).toBe(true);

    await page.getByTestId("draft-create").click();
    await expect(draftRows(page)).toHaveCount(0, { timeout: 30_000 });
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(tableRows(page, token)).toHaveCount(5);
  });

  test.describe("mobile", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("shows no draft area", async ({ page, base }) => {
      await page.goto(`${base}/discovery?view=table`);
      await page.waitForLoadState("networkidle");
      await expect(page.locator('[data-slot="table-container"]')).toBeVisible();
      await expect(page.getByTestId("grid-draft-area")).toHaveCount(0);
    });
  });
});
