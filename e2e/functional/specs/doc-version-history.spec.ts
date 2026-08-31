/**
 * Doc Version History functional spec.
 *
 * Journey: Create a doc via the UI → edit its content → save a named
 *          snapshot (deterministic second version, avoiding a real wait on
 *          the 5-minute auto-snapshot coalescing window) → edit the content
 *          again → open the Version History panel → see the saved version
 *          listed → view its diff against the current content → restore it →
 *          confirm the editor's content reverts to the saved version.
 *
 * No changes needed to e2e/functional/global-setup.ts / seed-e2e.ts — no Doc
 * rows are currently seeded there, so this spec self-seeds a fresh doc.
 */
import { test, expect } from "../fixtures/index";

test.describe("Doc Version History", () => {
  test(
    "edit → save named version → edit again → restore reverts content",
    async ({ page, base }) => {
      const ts = Date.now();
      const originalContent = `E2E original content ${ts}`;
      const editedContent = `E2E edited content ${ts}`;
      const versionLabel = `E2E snapshot ${ts}`;

      // ── 1. Navigate to Docs and create a fresh page ─────────────────────────
      await page.goto(`${base}/docs`);
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: "New" }).click();
      await page.waitForURL(/\/docs\/[0-9a-f-]+$/, { timeout: 15_000 });

      const editor = page.locator(".ProseMirror");
      await expect(editor).toBeVisible({ timeout: 10_000 });

      // ── 2. Write the original content and confirm it persisted ──────────────
      // Wait for this edit's server action response. A fixed delay only waits
      // for the debounce; under full-suite load the database write may still
      // be in flight when reload cancels the request.
      const originalSave = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.request().headers()["next-action"] !== undefined &&
          response.ok()
      );
      await editor.click();
      await page.keyboard.type(originalContent);
      await originalSave;
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(editor).toContainText(originalContent, { timeout: 15_000 });

      // ── 3. Save a named version — deterministic, bypasses the 5-minute
      //       auto-snapshot coalescing window that would make this test slow
      //       and flaky if we instead relied on the automatic snapshot path.
      await page.getByTitle("Save named version").click();
      const labelInput = page.getByPlaceholder("Label (optional)");
      await labelInput.fill(versionLabel);
      await labelInput.press("Enter");
      await expect(labelInput).not.toBeVisible({ timeout: 10_000 });

      // ── 4. Edit the content again, so current != the saved version ──────────
      await editor.click();
      await page.keyboard.press("ControlOrMeta+A");
      const editedSave = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.request().headers()["next-action"] !== undefined &&
          response.ok()
      );
      await page.keyboard.type(editedContent);
      await editedSave;
      // Reload also gives the doc page's server component a chance to
      // re-fetch its `versions` prop with the named snapshot from step 4 --
      // needed for the panel to list it in step 6.
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(editor).toContainText(editedContent, { timeout: 15_000 });

      // ── 5. Open Version History and see the saved version listed ────────────
      await page.getByTitle("Version history").click();
      const panelHeading = page.getByRole("heading", { name: "Version History" });
      await expect(panelHeading).toBeVisible({ timeout: 10_000 });
      const versionRow = page
        .locator('[data-testid="doc-version-list"] button')
        .filter({ hasText: versionLabel });
      await expect(versionRow).toBeVisible({ timeout: 10_000 });

      // ── 6. Click it to view the diff against current content ────────────────
      // diff_main renders delete and insert spans back-to-back rather than
      // as a full contiguous copy of each side (e.g. "original" and "edited"
      // sit adjacent with no space between, since only the differing word
      // changed) -- so assert on the distinguishing words independently
      // rather than the full original/edited strings verbatim.
      await versionRow.click();
      const diff = page.getByTestId("doc-version-diff");
      await expect(diff).toBeVisible({ timeout: 10_000 });
      await expect(diff).toContainText("original");
      await expect(diff).toContainText("edited");

      // ── 7. Restore — confirm() dialog must be accepted ───────────────────────
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "Restore this version" }).click();

      // Panel closes on successful restore.
      await expect(panelHeading).not.toBeVisible({ timeout: 10_000 });

      // ── 8. Editor content reverted to the restored (original) version ───────
      await expect(editor).toContainText(originalContent, { timeout: 10_000 });
      await expect(editor).not.toContainText(editedContent);
    }
  );
});
