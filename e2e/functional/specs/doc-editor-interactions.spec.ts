/**
 * Docs editor interactions: selection bubble, "/" block menu, gutter block handle, quiet save status, and the compact toolbar that
 * replaces the bubble on narrow screens.
 *
 * Self-seeds: /docs redirects to an existing document when one exists, otherwise a new one is created.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";
import { clickNewDoc } from "../fixtures/docs";

async function openDoc(page: Page, base: string) {
  // Always create a fresh doc. /docs redirects to the shared seeded baseline doc, and other specs run in parallel and edit it, which
  // surfaces as a save conflict here.
  await page.goto(`${base}/docs`);
  await page.waitForLoadState("networkidle");
  await clickNewDoc(page);
  // The new document's editor can remount just after the URL changes; wait until it has settled and is empty before typing, or the
  // typed text lands in an editor that is then replaced.
  await page.waitForLoadState("networkidle");
  const editor = page.locator(".ProseMirror");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor.locator("p.is-editor-empty")).toBeVisible();
  await page.waitForTimeout(500);
  // Start from a known empty body.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ArrowRight");
  return editor;
}

test.describe.configure({ mode: "serial" });

test.describe("Doc editor interactions (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false });

  // QUARANTINE(prod-e2e): intermittent Home + Shift+ArrowRight selection race before autosave settles (job 01M7CSWFSJH8VNGES39CPPFV5X; same family as lines 60 and 191). See e2e/functional/QUARANTINE.md.
  test.fixme("selection bubble formats text and links; there is no sticky toolbar", async ({ page, base }) => {
    const editor = await openDoc(page, base);
    await expect(page.getByTitle("Heading 1", { exact: true })).toHaveCount(0);
    await page.keyboard.type("Make this word bold please");
    await page.keyboard.press("Home");
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight");

    const bubble = page.getByTestId("doc-bubble-menu");
    await expect(bubble).toBeVisible({ timeout: 5_000 });
    await bubble.getByTitle("Bold").click();
    await expect(editor.locator("strong")).toHaveText("Make");

    await bubble.getByTitle("Link").click();
    await page.getByLabel("Link address").fill("example.com");
    await page.keyboard.press("Enter");
    await expect(editor.locator("a[href='https://example.com']")).toContainText("Make");

    await expect(bubble).toBeVisible();
    await bubble.getByTitle("Heading 2").click();
    await expect(editor.locator("h2")).toContainText("Make this word bold please");
  });

  // QUARANTINE(prod-e2e): intermittent selection flake - doc-bubble-menu not visible within 5s (job 01M7C5MDZS5DWAS1BS9YAH2KA1). See e2e/functional/QUARANTINE.md.
  test.fixme("clicking away from a selection moves the caret and dismisses the bubble", async ({ page, base }) => {
    const editor = await openDoc(page, base);
    await page.keyboard.type("Alpha first line");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Omega last line");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
    await expect(page.getByTestId("doc-bubble-menu")).toBeVisible();
    await editor.locator("p", { hasText: "Omega" }).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("!");
    await expect(page.getByTestId("doc-bubble-menu")).toBeHidden();
    await expect(editor.locator("p").last()).toHaveText("Omega last line!");
    await expect(editor.locator("p").first()).toHaveText("Alpha first line");
  });

  test("selection bubble keeps the comment flow", async ({ page, base }) => {
    await openDoc(page, base);
    await page.keyboard.type("COMMENTWORD in a sentence");
    // A comment anchors to saved content: wait for the autosave to settle first.
    await expect(page.getByTestId("doc-save-status")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
    await page.keyboard.press("Home");
    for (let i = 0; i < "COMMENTWORD".length; i++) await page.keyboard.press("Shift+ArrowRight");
    const commentButton = page.getByTitle("Comment on selection");
    await expect(commentButton).toBeVisible({ timeout: 5_000 });
    await commentButton.click();
    await expect(page.getByTestId("new-comment-popover")).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Comment", exact: true });
    await composer.fill("Bubble comment");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.locator(".doc-comment-highlight")).toContainText("COMMENTWORD");
  });

  test('"/" opens the block menu and inserts blocks', async ({ page, base }) => {
    const editor = await openDoc(page, base);
    await page.keyboard.type("/head");
    const menu = page.getByTestId("block-slash-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("block-slash-h1")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect(editor.locator("h2")).toHaveCount(1);
    await page.keyboard.type("A section");

    await page.keyboard.press("Enter");
    await page.keyboard.type("/quo");
    await page.keyboard.press("Enter");
    await expect(editor.locator("blockquote")).toHaveCount(1);
    await page.keyboard.type("Pull this out");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    // Escape closes without changing the text.
    await page.keyboard.type("/div");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(editor).toContainText("/div");
    await expect(editor.locator("hr")).toHaveCount(0);
    // Backspace the dismissed text, retype, and Enter applies the divider.
    for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
    await page.keyboard.type("/div");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(editor.locator("hr")).toHaveCount(1);

    await page.keyboard.type("/table");
    await page.keyboard.press("Enter");
    await expect(editor.locator("table")).toHaveCount(1);
  });

  test("block handle: plus opens the menu, grip drags a block", async ({ page, base }) => {
    const editor = await openDoc(page, base);
    await page.keyboard.type("First block");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second block");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Third block");

    const first = editor.locator("p", { hasText: "First block" });
    await first.hover();
    const handle = page.getByTestId("doc-block-handle");
    await expect(handle).toBeVisible();
    await handle.getByTitle("Add block below").click();
    await expect(page.getByTestId("block-slash-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");

    // Drag "First block" below "Third block".
    await page.mouse.move(5, 5);
    await first.hover();
    const grip = page.getByTestId("doc-block-handle").getByTitle("Drag to move");
    await expect(grip).toBeVisible();
    const third = editor.locator("p", { hasText: "Third block" });
    const box = (await third.boundingBox())!;
    // Drive the native drag by hand: down on the grip, move across the page in steps, release over the lower half of the last block.
    const gripBox = (await grip.boundingBox())!;
    const thirdBox = (await third.boundingBox())!;
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(gripBox.x + 30, gripBox.y + 10, { steps: 5 });
    await page.mouse.move(thirdBox.x + thirdBox.width - 4, thirdBox.y + box.height - 2, { steps: 15 });
    await page.mouse.up();
    const texts = await editor.locator("p").allInnerTexts();
    expect(texts.filter((t) => t.trim())).toEqual(["Second block", "Third block", "First block"]);
  });

  test('"Saved" is a brief confirmation, not a permanent label', async ({ page, base }) => {
    await openDoc(page, base);
    await page.keyboard.type("Some text to save");
    const status = page.getByTestId("doc-save-status");
    await expect(status).toContainText("Saved", { timeout: 10_000 });
    await expect(status).not.toContainText("Saved", { timeout: 6_000 });
    await expect(status).toHaveAttribute("data-state", "saved");
  });

  test("page-level actions live in the header", async ({ page, base }) => {
    await openDoc(page, base);
    await expect(page.getByTitle("Comments", { exact: true })).toBeVisible();
    await expect(page.getByTitle("Version history", { exact: true })).toBeVisible();
    await expect(page.getByTitle("Save named version")).toBeVisible();
  });
});

test.describe("Doc editor interactions (mobile)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // QUARANTINE(prod-e2e): intermittent Home + Shift+ArrowRight selection race before autosave settles - bolded 'T' instead of 'Tap' (job 01M7D1C739C829SX990HZFVP6W). See e2e/functional/QUARANTINE.md.
  test.fixme("keeps a compact toolbar and no selection bubble", async ({ page, base }) => {
    const editor = await openDoc(page, base);
    await expect(page.getByTitle("Bold", { exact: true })).toBeVisible();
    await expect(page.getByTitle(/comment/i).first()).toBeVisible();
    await page.keyboard.type("Tap bold on this");
    await page.keyboard.press("Home");
    for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
    await expect(page.getByTestId("doc-bubble-menu")).toHaveCount(0);
    await page.getByTitle("Bold", { exact: true }).click();
    await expect(editor.locator("strong")).toHaveText("Tap");
  });
});
