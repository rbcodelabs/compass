import { test, expect } from "../fixtures/index";
import { clickNewDoc } from "../fixtures/docs";
import type { Page } from "@playwright/test";

async function createDoc(page: Page, base: string) {
  await page.goto(`${base}/docs`);
  await clickNewDoc(page)
  await page.waitForURL(/\/docs\/(?:[0-9a-f-]+|DOC-\d+)$/);
  await expect(page.locator(".ProseMirror")).toBeVisible();
}

// Typing the fence opens a code block via tiptap's input rule; an empty
// mermaid block starts in Source mode.
async function typeMermaidBlock(page: Page, source: string) {
  const editor = page.locator(".ProseMirror");
  await editor.click();
  await page.keyboard.type("```mermaid ");
  await page.keyboard.type(source);
}

// QUARANTINE(prod-e2e): known baseline failure on dev and prod - mermaid-diagram svg not visible within 5s (job 01M7C5MDZS5DWAS1BS9YAH2KA1). See e2e/functional/QUARANTINE.md.
test.fixme("a mermaid fence renders as a diagram and toggles back to editable source", async ({ page, base }) => {
  await createDoc(page, base);
  await typeMermaidBlock(page, "flowchart LR\nA[Start] --> B[Done]");

  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const diagram = page.getByTestId("mermaid-diagram");
  await expect(diagram.locator("svg")).toBeVisible();
  await expect(diagram).toContainText("Start");

  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.locator(".ProseMirror pre code.language-mermaid")).toContainText("flowchart LR");
});

// QUARANTINE(prod-e2e): known baseline failure on dev and prod - mermaid-error does not include raw source text (job 01M7C5MDZS5DWAS1BS9YAH2KA1). See e2e/functional/QUARANTINE.md.
test.fixme("invalid mermaid syntax shows the error and the raw source", async ({ page, base }) => {
  await createDoc(page, base);
  await typeMermaidBlock(page, "flowchart LR\nA --> --> B [");

  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const error = page.getByTestId("mermaid-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("A --> --> B [");
});
