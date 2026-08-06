/**
 * Feedback Attachments functional spec.
 *
 * Journey: Enable the public feedback portal in Settings → submit an idea via
 *          the public portal with a screenshot attached (page.setInputFiles on
 *          the file input, waiting for the client-side upload to finish) →
 *          verify a thumbnail/attachment indicator appears in the portal
 *          list → open the internal feedback board and confirm the same
 *          attachment is visible there too.
 *
 * Modeled on feedback-bug-roadmap.spec.ts's portal-enable → submit →
 * verify-on-internal-board flow, extended to cover the new file upload path
 * (app/api/portal/[orgSlug]/[workspaceSlug]/feedback/upload/route.ts) and the
 * attachments read-path added to both the portal and internal feedback pages.
 */
import path from "path";
import { test, expect } from "../fixtures/index";

const FIXTURE_IMAGE = path.join(__dirname, "..", "..", "fixtures", "test-image.png");

test.describe("Feedback Attachments", () => {
  test.skip(!process.env.BLOB_READ_WRITE_TOKEN, "requires BLOB_READ_WRITE_TOKEN");
  test(
    "submit feedback with a screenshot via the portal → attachment visible on portal and internal board",
    async ({ page, base, orgSlug, workspaceSlug }) => {
      const ts = Date.now();
      const ideaTitle = `E2E Attachment ${ts}`;

      // ── 1. Enable the public feedback portal (Settings) ───────────────────
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");

      const toggle = page.getByRole("switch").nth(1);
      const isChecked = await toggle.getAttribute("aria-checked");
      if (isChecked !== "true") {
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
      }

      // ── 2. Submit feedback via the public portal with an attached image ───
      await page.goto(`/portal/${orgSlug}/${workspaceSlug}/feedback`);
      await page.waitForLoadState("networkidle");

      await page.getByLabel("Title").fill(ideaTitle);
      await page.locator("#fb-attachments").setInputFiles(FIXTURE_IMAGE);

      // Wait for the client-side upload to finish before submitting — the
      // Submit button is disabled and labeled "Uploading..." while in flight.
      await expect(page.getByRole("button", { name: "Uploading..." })).toHaveCount(0, {
        timeout: 15_000,
      });

      const submitButton = page.getByRole("button", { name: "Submit" });
      await expect(submitButton).toBeEnabled();
      await submitButton.click();

      await expect(page.getByText("Thank you for your feedback!")).toBeVisible({ timeout: 10_000 });

      // The new item's card shows an attachment thumbnail (an <img> linking
      // to the uploaded blob). .first() grabs the outermost matching div (the
      // full card, which contains the title column and the sibling
      // attachments row) — .last() would resolve to the innermost div (just
      // the title + badges), missing the attachments entirely. Same gotcha
      // documented in feedback-bug-roadmap.spec.ts for the action column.
      const portalCard = page.locator("div").filter({ hasText: ideaTitle }).first();
      await expect(portalCard.locator("img")).toBeVisible({ timeout: 10_000 });

      // ── 3. Verify the same attachment shows on the internal board ─────────
      await page.goto(`${base}/feedback`);
      await page.waitForLoadState("networkidle");

      await expect(page.getByText(ideaTitle)).toBeVisible({ timeout: 10_000 });
      const row = page.locator("div").filter({ hasText: ideaTitle }).first();
      await expect(row.locator("img")).toBeVisible({ timeout: 10_000 });
    }
  );
});
