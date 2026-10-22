import { test, expect } from "../fixtures/index";
import type { Page } from "@playwright/test";

async function createDoc(page: Page, base: string) {
  await page.goto(`${base}/docs`);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.waitForURL(/\/docs\/[0-9a-f-]+$/);
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

test("a mermaid fence renders as a diagram and toggles back to editable source", async ({ page, base }) => {
  await createDoc(page, base);
  await typeMermaidBlock(page, "flowchart LR\nA[Start] --> B[Done]");

  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const diagram = page.getByTestId("mermaid-diagram");
  await expect(diagram.locator("svg")).toBeVisible();
  await expect(diagram).toContainText("Start");

  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.locator(".ProseMirror pre code.language-mermaid")).toContainText("flowchart LR");
});

test("invalid mermaid syntax shows the error and the raw source", async ({ page, base }) => {
  await createDoc(page, base);
  await typeMermaidBlock(page, "flowchart LR\nA --> --> B [");

  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const error = page.getByTestId("mermaid-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("A --> --> B [");
});
