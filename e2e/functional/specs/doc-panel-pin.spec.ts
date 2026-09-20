import { test, expect } from "../fixtures/index";
import type { Page } from "@playwright/test";

async function createDoc(page: Page, base: string) {
  await page.goto(`${base}/docs`);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.waitForURL(/\/docs\/[0-9a-f-]+$/);
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.locator(".ProseMirror")).toBeEmpty();
}

async function seedPreferences(page: Page, comments: string, history: string) {
  await page.context().addCookies([
    { name: "compass_panel_docsComments", value: comments, url: page.url() },
    { name: "compass_panel_docsHistory", value: history, url: page.url() },
  ]);
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();
}

const pinned = (page: Page) => page.locator('[data-slot="pinned-panel"][data-panel-id^="docs"]');

test("Docs pin preferences are independent, mutually exclusive, and survive reload", async ({ page, base }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createDoc(page, base);
  await page.getByTitle("Comments", { exact: true }).click();
  await expect(page.locator('[data-slot="sheet-content"]')).toBeVisible();
  await page.getByRole("button", { name: "Pin panel", exact: true }).click();
  await expect(pinned(page)).toHaveAttribute("data-panel-id", "docsComments");
  await page.locator(".ProseMirror").fill("The editor remains editable beside Comments.");
  await page.locator(".ProseMirror").press("Escape");
  await expect(pinned(page)).toBeVisible();
  const handle = pinned(page).getByRole("separator", { name: "Resize panel" });
  await handle.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "320");
  await page.getByTitle("Version history", { exact: true }).click();
  await expect(pinned(page)).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Version History" })).toBeVisible();
  await page.getByRole("button", { name: "Pin panel", exact: true }).click();
  await expect(pinned(page)).toHaveAttribute("data-panel-id", "docsHistory");
  await pinned(page).getByRole("separator").press("Home");
  await pinned(page).getByRole("separator").press("ArrowLeft");
  await page.getByTitle("Comments", { exact: true }).click();
  await expect(pinned(page)).toHaveCount(1);
  await expect(pinned(page).getByRole("separator")).toHaveAttribute("aria-valuenow", "320");
  await pinned(page).getByRole("button", { name: "Close panel" }).click();
  await page.reload();
  await page.getByTitle("Version history", { exact: true }).click();
  await expect(pinned(page).getByRole("separator")).toHaveAttribute("aria-valuenow", "336");
  await page.getByTitle("Comments", { exact: true }).click();
  await expect(pinned(page).getByRole("separator")).toHaveAttribute("aria-valuenow", "320");
  await pinned(page).getByRole("separator").press("Escape");
  await expect(pinned(page)).toHaveCount(0);
});

test("stored maximum width and drag retain the editor floor", async ({ page, base }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createDoc(page, base);
  await seedPreferences(page, "1:720", "1:448");
  await page.getByTitle("Comments", { exact: true }).click();
  await expect(pinned(page)).toBeVisible();
  const column = page.locator('[data-slot="doc-editor-column"]');
  await expect.poll(async () => (await column.boundingBox())!.width).toBeGreaterThanOrEqual(479);
  const separator = pinned(page).getByRole("separator");
  const box = (await separator.boundingBox())!;
  await page.mouse.move(box.x, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(0, box.y + 80, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await column.boundingBox())!.width).toBeGreaterThanOrEqual(479);
  expect((await pinned(page).boundingBox())!.width).toBeLessThanOrEqual(720);
  await page.setViewportSize({ width: 1280, height: 800 });
  if (await pinned(page).count()) {
    await expect.poll(async () => (await column.boundingBox())!.width).toBeGreaterThanOrEqual(479);
  } else {
    await expect(page.getByRole("dialog", { name: "Comments" })).toBeVisible();
  }
});

test("restoring from pinned History updates the editor and leaves History open", async ({ page, base }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createDoc(page, base);
  const editor = page.locator(".ProseMirror");
  const waitForSave = () => page.waitForResponse((r) => r.request().method() === "POST" && !!r.request().headers()["next-action"] && r.ok());
  const originalSave = waitForSave();
  await editor.fill("Original pinned history content");
  await originalSave;
  await page.getByTitle("Save named version").click();
  await page.getByPlaceholder("Label (optional)").fill("Pinned snapshot");
  await page.getByPlaceholder("Label (optional)").press("Enter");
  await expect(page.getByPlaceholder("Label (optional)")).not.toBeVisible();
  const editedSave = waitForSave();
  await editor.fill("Changed pinned history content");
  await editedSave;
  await seedPreferences(page, "0:448", "1:448");
  await page.getByTitle("Version history", { exact: true }).click();
  await pinned(page).getByRole("button", { name: /Pinned snapshot/ }).click();
  await expect(pinned(page).getByTestId("doc-version-diff")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await pinned(page).getByRole("button", { name: "Restore this version" }).click();
  await expect(editor).toContainText("Original pinned history content");
  await expect(pinned(page)).toHaveAttribute("data-panel-id", "docsHistory");
  await expect(pinned(page).getByText("Current version")).toBeVisible();
});

test("responsive Docs panels preserve cookies and produce visual evidence", async ({ page, base }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createDoc(page, base);
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && !!r.request().headers()["next-action"] && r.ok());
  await page.locator(".ProseMirror").fill(`Docs panel layout ${"unbroken".repeat(100)}`);
  await saved;
  await seedPreferences(page, "1:720", "1:448");
  const before = (await page.context().cookies()).filter((c) => c.name.startsWith("compass_panel_docs")).map((c) => `${c.name}=${c.value}`).sort();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.classList.toggle("dark", value === "dark"); }, theme);
    for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 900, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      for (const panel of ["Comments", "Version history"]) {
        await page.getByTitle(panel, { exact: true }).click();
        const heading = panel === "Comments" ? "Comments" : "Version History";
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        if (size.width < 1024) {
          await expect(page.getByRole("dialog", { name: heading })).toBeVisible();
          await expect(pinned(page)).toHaveCount(0);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const surface = await pinned(page).count() ? pinned(page) : page.getByRole("dialog", { name: heading });
        // Visibility alone accepts an opening sheet at opacity zero. Capture
        // its settled content, including on reduced-size mobile viewports.
        await expect(surface).toHaveCSS("opacity", "1");
        await page.screenshot({
          path: testInfo.outputPath(`${theme}-${size.width}-${panel.replaceAll(" ", "-")}.png`),
          animations: "disabled",
        });
        if (await pinned(page).count()) await pinned(page).getByRole("button", { name: "Close panel" }).click();
        else await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      }
    }
  }
  const after = (await page.context().cookies()).filter((c) => c.name.startsWith("compass_panel_docs")).map((c) => `${c.name}=${c.value}`).sort();
  expect(after).toEqual(before);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTitle("Comments", { exact: true }).click();
  await expect(pinned(page)).toBeVisible();
});
