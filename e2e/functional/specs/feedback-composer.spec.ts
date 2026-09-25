/**
 * Feedback composer functional spec.
 *
 * Journey: on the workspace Feedback board, "New Feedback" opens the composer
 * docked in the right-hand panel slot (the board stays visible and usable
 * beside it) → choose a type, write a title and a Markdown body, optionally
 * attach an image → submit with ⌘/Ctrl+Enter → the new row appears in the
 * grid, and the same panel slot now shows the created item with its Markdown
 * rendered and its attachment displayed.
 *
 * Replaces the old centered "New Feedback" modal (a Select, a one-line Input
 * and a plain Textarea). See components/feedback/feedback-composer.tsx.
 *
 * The attachment test needs real Vercel Blob storage (the upload goes
 * browser → Blob directly with a server-minted client token), so like
 * feedback-attachments.spec.ts it only runs when BLOB_READ_WRITE_TOKEN is set.
 */
import path from "path";
import { test, expect } from "../fixtures/index";

const FIXTURE_IMAGE = path.join(__dirname, "..", "..", "fixtures", "test-image.png");

async function openComposer(page: import("@playwright/test").Page) {
  await page
    .locator('[data-slot="workspace-header"]')
    .getByRole("button", { name: "New Feedback" })
    .click();
  const composer = page.locator('[data-slot="feedback-composer"]');
  await expect(composer).toBeVisible();
  return composer;
}

test.describe("Feedback composer panel", () => {
  test("creates Markdown feedback from a docked panel and hands the slot to the new item", async ({
    page,
    base,
  }) => {
    const title = `E2E Composer Bug ${Date.now()}`;
    await page.goto(`${base}/feedback`);
    await page.waitForLoadState("networkidle");

    const composer = await openComposer(page);

    // Docked beside the board — a column, not a modal sheet — and the board
    // is still interactive while the composer is open.
    await expect(page.locator('[data-slot="pinned-panel"]')).toContainText("New feedback");
    await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Filters" })).toBeEnabled();

    // Title is autofocused.
    await expect(composer.getByLabel("Title")).toBeFocused();

    // Type is a pair of selectable cards, not a dropdown.
    const bug = composer.getByRole("radio", { name: /^Bug/ });
    await bug.click();
    await expect(bug).toHaveAttribute("aria-checked", "true");

    await composer.getByLabel("Title").fill(title);

    // The one-click template for bugs, written through the rich editor.
    await composer.getByRole("button", { name: "Insert bug template" }).click();
    await expect(composer.getByRole("heading", { name: "Steps to reproduce" })).toBeVisible();

    // Switch to source mode to type exact Markdown.
    await composer.getByRole("button", { name: "Markdown", exact: true }).click();
    await composer
      .getByLabel("Details Markdown source")
      .fill("## Steps to reproduce\n\n1. Open **Reports**\n2. Export 10 rows\n\n## Actual result\n\nOnly 9 rows arrive.");

    await composer.getByLabel("Title").press("ControlOrMeta+Enter");

    // The composer is replaced in the same slot by the created item.
    await expect(page).toHaveURL(/detail=feedback%3A[0-9a-f-]{36}/, { timeout: 15_000 });
    const panel = page.locator('[data-slot="pinned-panel"]');
    await expect(panel.getByText(title)).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole("heading", { name: "Steps to reproduce" })).toBeVisible();
    await expect(panel.locator("strong", { hasText: "Reports" })).toBeVisible();
    await expect(panel).not.toContainText("**Reports**");

    // And it is in the grid, previewed as plain text rather than raw Markdown.
    const row = page.getByTestId("grid-row").filter({ hasText: title });
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    await expect(row).toContainText("Steps to reproduce Open Reports Export 10 rows");
    await expect(row).not.toContainText("##");

    // Back does not return to an emptied composer: the hand-off replaced it.
    await page.goBack();
    await expect(page.locator('[data-slot="feedback-composer"]')).toHaveCount(0);
  });

  test("keeps the draft across a reload and only discards it after confirmation", async ({
    page,
    base,
  }) => {
    const title = `E2E Composer Draft ${Date.now()}`;
    await page.goto(`${base}/feedback`);
    await page.waitForLoadState("networkidle");

    let composer = await openComposer(page);
    await composer.getByLabel("Title").fill(title);
    await page.reload();
    await page.waitForLoadState("networkidle");

    composer = page.locator('[data-slot="feedback-composer"]');
    await expect(composer.getByLabel("Title")).toHaveValue(title);
    await expect(composer.getByText("Restored your unsent draft.")).toBeVisible();

    // Esc closes the panel but keeps the draft.
    await composer.getByLabel("Title").press("Escape");
    await expect(page.locator('[data-slot="feedback-composer"]')).toHaveCount(0);
    composer = await openComposer(page);
    await expect(composer.getByLabel("Title")).toHaveValue(title);

    // Cancel asks first; "Keep editing" changes nothing.
    await composer.getByRole("button", { name: "Cancel", exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Discard this draft?");
    await confirm.getByRole("button", { name: "Keep editing" }).click();
    await expect(composer.getByLabel("Title")).toHaveValue(title);

    await composer.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Discard draft" }).click();
    await expect(page.locator('[data-slot="feedback-composer"]')).toHaveCount(0);

    composer = await openComposer(page);
    await expect(composer.getByLabel("Title")).toHaveValue("");
    await expect(page.getByTestId("grid-row").filter({ hasText: title })).toHaveCount(0);
  });

  test.describe("with attachments", () => {
    test.skip(!process.env.BLOB_READ_WRITE_TOKEN, "requires BLOB_READ_WRITE_TOKEN");

    test("attaches an image, submits, and shows it on the created item and in the grid", async ({
      page,
      base,
    }) => {
      const title = `E2E Composer Attachment ${Date.now()}`;
      await page.goto(`${base}/feedback`);
      await page.waitForLoadState("networkidle");

      const composer = await openComposer(page);
      await composer.getByLabel("Title").fill(title);
      await composer.getByRole("button", { name: "Markdown", exact: true }).click();
      await composer.getByLabel("Details Markdown source").fill("See the **screenshot**.");

      await composer.getByTestId("feedback-composer-file-input").setInputFiles(FIXTURE_IMAGE);
      const chip = composer.getByTestId("feedback-composer-attachment");
      await expect(chip).toContainText("test-image.png");
      await expect(chip).toHaveAttribute("data-status", "done", { timeout: 20_000 });

      await composer.getByRole("button", { name: "Submit", exact: true }).click();

      const panel = page.locator('[data-slot="pinned-panel"]');
      await expect(panel.getByText(title)).toBeVisible({ timeout: 15_000 });
      await expect(panel.locator("strong", { hasText: "screenshot" })).toBeVisible();
      const panelImage = panel.locator('img[alt="test-image.png"]');
      await expect(panelImage).toBeVisible({ timeout: 10_000 });
      await expect(panelImage).toHaveAttribute("src", /\.public\.blob\.vercel-storage\.com\//);

      const row = page.getByTestId("grid-row").filter({ hasText: title });
      await expect(row.locator('img[alt="test-image.png"]')).toBeVisible({ timeout: 10_000 });
    });
  });
});
