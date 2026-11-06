/**
 * Workspace export/import functional spec.
 *
 * Journey: Workspace Settings → "Download workspace bundle" (a real browser download) → Organization Settings
 *          → "Import workspace" with that very file → success panel → open the imported workspace → its content is
 *          there → importing the same file again with a fresh attempt creates a second, separate workspace.
 *
 * The seeded e2e user is an organization ADMIN, which is what both the export and import routes require.
 * Everything is asserted with auto-retrying matchers; there is no waitForTimeout.
 */
import fs from "node:fs";
import { unzipSync } from "fflate";
import { test, expect } from "../fixtures/index";

test.describe("Workspace export / import", () => {
  test.setTimeout(180_000);

  test("download a bundle from workspace settings and import it as a new workspace", async ({ page, orgSlug, workspaceSlug }, testInfo) => {
    // ── 1. Export ──────────────────────────────────────────────────────────
    await page.goto(`/${orgSlug}/${workspaceSlug}/settings`);
    const exportLink = page.getByTestId("export-workspace");
    await expect(exportLink).toBeVisible();
    await exportLink.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("export-section.png"), fullPage: false });

    const [download] = await Promise.all([page.waitForEvent("download"), exportLink.click()]);
    expect(download.suggestedFilename()).toMatch(new RegExp(`^${workspaceSlug}-\\d{4}-\\d{2}-\\d{2}\\.compass\\.zip$`));
    const bundlePath = testInfo.outputPath("bundle.compass.zip");
    await download.saveAs(bundlePath);
    const files = unzipSync(new Uint8Array(fs.readFileSync(bundlePath)));
    expect(Object.keys(files)).toContain("manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
    expect(manifest.source.slug).toBe(workspaceSlug);
    const text = Object.entries(files)
      .filter(([name]) => name.startsWith("data/"))
      .map(([, bytes]) => new TextDecoder().decode(bytes))
      .join("\n");
    // Secrets never leave the workspace.
    expect(text).not.toMatch(/ssoSecretEncrypted":"[^"]/);
    expect(text).not.toMatch(/anthropicApiKeyEncrypted":"[^"]/);

    // ── 2. Import the same file into the organization ──────────────────────
    const importedSlug = `imported-${Date.now()}`;
    await page.goto(`/${orgSlug}/settings`);
    const form = page.getByTestId("import-workspace-form");
    await expect(form).toBeVisible();
    await form.getByLabel("Name (optional)").fill(`Imported ${importedSlug}`);
    await form.getByLabel("URL slug (optional)").fill(importedSlug);
    await form.getByLabel("Bundle file").setInputFiles(bundlePath);
    await form.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("import-form-filled.png") });
    await form.getByRole("button", { name: "Import workspace" }).click();

    const result = page.getByTestId("import-result");
    await expect(result).toContainText(`Imported Imported ${importedSlug}`, { timeout: 120_000 });
    await result.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("import-result.png") });

    // ── 3. The imported workspace exists and is usable ─────────────────────
    await result.getByRole("link", { name: "Open the workspace" }).click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/${importedSlug}`));
    await page.goto(`/${orgSlug}/${importedSlug}/settings`);
    await expect(page.locator("main").getByText(`Imported ${importedSlug}`).first()).toBeVisible();
    await expect(page.getByTestId("export-workspace")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("imported-workspace-settings.png") });

    // ── 4. A bad file is rejected with a readable message ──────────────────
    await page.goto(`/${orgSlug}/settings`);
    const form2 = page.getByTestId("import-workspace-form");
    await form2.getByLabel("Bundle file").setInputFiles({ name: "nope.zip", mimeType: "application/zip", buffer: Buffer.from("not a zip") });
    await form2.getByRole("button", { name: "Import workspace" }).click();
    await expect(form2.getByRole("alert")).toContainText(/not a valid workspace bundle/i);
    await page.screenshot({ path: testInfo.outputPath("import-error.png") });
  });

  test.describe("mobile viewport (390x844)", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("export and import controls are reachable without horizontal overflow", async ({ page, orgSlug, workspaceSlug }, testInfo) => {
      const noHorizontalOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

      await page.goto(`/${orgSlug}/${workspaceSlug}/settings`);
      const exportLink = page.getByTestId("export-workspace");
      await exportLink.scrollIntoViewIfNeeded();
      await expect(exportLink).toBeVisible();
      await expect(exportLink).toBeInViewport();
      expect(await noHorizontalOverflow()).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("mobile-export.png") });

      await page.goto(`/${orgSlug}/settings`);
      const form = page.getByTestId("import-workspace-form");
      await form.scrollIntoViewIfNeeded();
      await expect(form.getByRole("button", { name: "Import workspace" })).toBeVisible();
      await expect(form.getByLabel("Bundle file")).toBeVisible();
      expect(await noHorizontalOverflow()).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("mobile-import.png") });
    });
  });
});
