import { test, expect } from "../fixtures/index";
import { clickNewDoc, waitForNewDocEditor } from "../fixtures/docs";

for (const [name, vp] of [["desktop", { width: 1280, height: 800 }], ["mobile", { width: 390, height: 844 }]] as const) {
  test(`mermaid ${name}`, async ({ page, base }) => {
    await page.setViewportSize(vp);
    await page.goto(`${base}/docs`);
    await clickNewDoc(page);
    await waitForNewDocEditor(page);
    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("```mermaid ");
    await expect(page.locator("[data-mermaid-block]")).toBeVisible();
    await expect.poll(() => editor.evaluate((el) => (el as unknown as { editor: { isActive(n: string): boolean } }).editor.isActive("codeBlock"))).toBe(true);
    await page.keyboard.type("flowchart LR\nA[Start] --> B[Done]");
    await page.waitForTimeout(600);
    await page.screenshot({ path: `test-results/shots/mermaid-${name}-source.png` });
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.getByTestId("mermaid-diagram").locator("svg")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/shots/mermaid-${name}-preview.png` });
  });
}
