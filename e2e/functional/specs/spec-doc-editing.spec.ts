/**
 * Spec docs phase 4 (editing) functional spec.
 *
 * Journey: a solution's panel -> "New spec" -> rename the solution from its card in the doc (the record changes, the doc's stored markdown
 * does not) -> add an assumption with the "/" menu (the record is created and its embed persists) -> delete that assumption elsewhere ->
 * the doc shows the unavailable placeholder -> Remove takes only the embed out of the doc.
 *
 * Deliberately does NOT open the Library: it moved into the agent rail ("Show library"), and docs are reached here through the solution
 * panel's Specs section and direct URLs.
 */
import { test, expect } from "../fixtures/index";
import { createOpportunityFromBoard } from "../fixtures/opportunity-composer";
import { openFullPage } from "../fixtures/full-page";
import type { Page } from "@playwright/test";

const SAVE_STATUS = '[data-testid="doc-save-status"]';
const EMBED_CARD = '[data-slot="spec-embed-card"]';

/** An opportunity with one solution, the opportunity's full-page URL, and a new spec for the solution (the page is left on the spec). */
async function createSpecFromSolution(page: Page, base: string, stamp: number) {
  const oppTitle = `E2E SpecEdit Opportunity ${stamp}`;
  const solTitle = `E2E SpecEdit Solution ${stamp}`;

  await page.goto(`${base}/discovery`);
  await page.waitForLoadState("networkidle");
  await createOpportunityFromBoard(page, oppTitle);
  await expect(page.getByRole("button", { name: oppTitle, exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: oppTitle, exact: true }).click();
  await openFullPage(page);
  const oppUrl = page.url();

  await page.getByRole("button", { name: "Add Solution" }).click();
  await page.getByLabel("Title").fill(solTitle);
  await page.getByRole("button", { name: "Add Solution" }).last().click();
  await expect(page.getByText(solTitle).first()).toBeVisible({ timeout: 10_000 });

  // The solution's panel has the Specs section; "New spec" is an explicit action that creates the doc and opens it.
  await page.getByRole("button", { name: solTitle, exact: true }).click();
  const newSpec = page.getByRole("button", { name: "New spec" });
  await expect(newSpec).toBeEnabled({ timeout: 15_000 });
  await newSpec.click();
  await page.waitForURL(/\/docs\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.locator('[data-slot="spec-doc-header"]')).toContainText(`For ${solTitle}`);
  return { oppTitle, solTitle, oppUrl, docUrl: page.url() };
}

/** The markdown the editor currently holds (after a reload: exactly what is stored, since nothing has been edited). */
function editorMarkdown(page: Page) {
  return page.evaluate(() => {
    const dom = document.querySelector(".ProseMirror") as unknown as { editor: { storage: { markdown: { getMarkdown(): string } } } };
    return dom.editor.storage.markdown.getMarkdown();
  });
}

/** Put the cursor in a fresh empty paragraph at the very end of the document. */
async function cursorToNewLastParagraph(page: Page) {
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
}

test.describe("Spec docs: editing", () => {
  test("rename from a card, add with '/', delete elsewhere, then Remove", async ({ page, base }) => {
    const stamp = Date.now();
    const assumptionTitle = `E2E SpecEdit Assumption ${stamp}`;
    const { solTitle, oppUrl, docUrl } = await createSpecFromSolution(page, base, stamp);
    const status = page.locator(SAVE_STATUS);

    // 1. Rename the solution from its card. The record changes; the document does not.
    const renamed = `${solTitle} (renamed)`;
    await expect(page.getByRole("group", { name: `Solution: ${solTitle}` })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: `Rename ${solTitle}` }).click();
    const titleInput = page.getByTestId("embed-title-input");
    await titleInput.fill(renamed);
    await titleInput.press("Enter");
    await expect(page.getByRole("group", { name: `Solution: ${renamed}` })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("embed-save-state")).toHaveAttribute("data-state", "saved");
    // A card edit is not a document edit: the doc's autosave never started.
    await expect(status).toHaveAttribute("data-state", "idle");

    await page.reload();
    await expect(page.getByRole("group", { name: `Solution: ${renamed}` })).toBeVisible({ timeout: 15_000 });
    const stored = await editorMarkdown(page);
    // The live title won, and the cached title in the stored markdown is still the one written when the spec was created.
    expect(stored).toContain(`[${solTitle}](compass://solution/`);
    expect(stored).not.toContain(renamed);

    // 2. Add an assumption with the "/" menu.
    await cursorToNewLastParagraph(page);
    await page.keyboard.type("/");
    const menu = page.getByTestId("spec-slash-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("spec-slash-assumption")).toBeVisible();
    await menu.getByTestId("spec-slash-assumption").getByRole("button").click();
    await page.getByTestId("spec-slash-title").fill(assumptionTitle);
    await page.getByTestId("spec-slash-create").click();
    await expect(page.getByRole("group", { name: `Assumption: ${assumptionTitle}` })).toBeVisible({ timeout: 20_000 });
    await expect(menu).toBeHidden();
    // Exactly one embed for it, and no stray "/" left behind.
    await expect(status).toHaveAttribute("data-state", "saved", { timeout: 20_000 });

    await page.reload();
    await expect(page.getByRole("group", { name: `Assumption: ${assumptionTitle}` })).toBeVisible({ timeout: 15_000 });
    const withAssumption = await editorMarkdown(page);
    expect(withAssumption.match(new RegExp(`compass://assumption/`, "g")) ?? []).toHaveLength(1);
    expect(withAssumption).not.toMatch(/^\/$/m);

    // 3. Delete the assumption from the solution's own panel.
    await page.goto(oppUrl);
    await page.getByRole("button", { name: renamed, exact: true }).click();
    const panel = page.locator('[data-slot="sheet-content"]');
    await expect(panel.getByText(assumptionTitle).first()).toBeVisible({ timeout: 15_000 });
    const row = panel.locator("div").filter({ hasText: assumptionTitle }).filter({ has: page.getByRole("button", { name: "Card actions" }) }).last();
    await row.getByRole("button", { name: "Card actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(panel.getByText(assumptionTitle)).toHaveCount(0, { timeout: 15_000 });

    // 4. The doc now shows the unavailable placeholder, with Remove. Removing it takes only the embed paragraph out.
    await page.goto(docUrl);
    const placeholder = page.locator(`${EMBED_CARD}[data-state="unavailable"]`);
    await expect(placeholder).toBeVisible({ timeout: 15_000 });
    await expect(placeholder).toContainText("Record unavailable");
    await placeholder.getByTestId("embed-remove").click();
    await expect(placeholder).toHaveCount(0);
    await expect(status).toHaveAttribute("data-state", "saved", { timeout: 20_000 });

    await page.reload();
    await expect(page.getByRole("group", { name: `Solution: ${renamed}` })).toBeVisible({ timeout: 15_000 });
    await expect(placeholder).toHaveCount(0);
    expect(await editorMarkdown(page)).not.toContain("compass://assumption/");
  });

  test("the '/' menu: Escape closes it, filtering works, and it stays on screen at phone width without moving the document", async ({ page, base }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createSpecFromSolution(page, base, Date.now());

    const heading = page.locator(".ProseMirror h2").first();
    await expect(heading).toBeVisible();
    await expect(page.locator(`${EMBED_CARD}[data-state="loading"]`)).toHaveCount(0, { timeout: 15_000 });
    await cursorToNewLastParagraph(page);
    const before = await heading.boundingBox();
    await page.keyboard.type("/");
    const menu = page.getByTestId("spec-slash-menu");
    await expect(menu).toBeVisible();

    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    // The menu floats over the page: nothing above the cursor moved.
    expect(await heading.boundingBox()).toEqual(before);

    await page.keyboard.type("ta");
    await expect(menu.getByTestId("spec-slash-task")).toBeVisible();
    await expect(menu.getByTestId("spec-slash-assumption")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });
});
