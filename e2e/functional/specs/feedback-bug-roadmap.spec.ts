/**
 * Feedback Bug → Roadmap functional spec.
 *
 * Journey: Enable the public feedback portal in Settings → submit a bug report
 *          via the public portal (using the Bug/Idea type toggle) → sign in
 *          internally and view the feedback board → confirm the bug is badged
 *          and shows the "Promote to roadmap" action (not the opportunity-link
 *          picker that ideas get) → promote it directly to the NOW horizon →
 *          verify it now shows "On roadmap" on the feedback board and appears
 *          as a Bug-badged card in the roadmap's NOW column.
 *
 * This exercises the new bug/idea split: bugs skip Opportunity → Solution →
 * Assumption → Experiment discovery entirely and go straight to the roadmap,
 * unlike the existing Discovery → Roadmap spec which covers the idea path.
 */
import { test, expect } from "../fixtures/index";

test.describe("Feedback Bug → Roadmap", () => {
  test(
    "submit a bug via the portal → promote directly to roadmap",
    async ({ page, base, orgSlug, workspaceSlug }) => {
      const ts = Date.now();
      const bugTitle = `E2E Bug ${ts}`;

      // ── 1. Enable the public feedback portal (Settings) ───────────────────
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");

      // PortalSettingsPanel renders three toggles in a fixed order: roadmap,
      // feedback, then (conditionally) portal-auth-required. The feedback
      // toggle is always the second switch on the page.
      const toggle = page.getByRole("switch").nth(1);

      const isChecked = await toggle.getAttribute("aria-checked");
      if (isChecked !== "true") {
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
      }

      // ── 2. Submit a bug via the public portal ──────────────────────────────
      await page.goto(`/portal/${orgSlug}/${workspaceSlug}/feedback`);
      await page.waitForLoadState("networkidle");

      // Select the "Bug" type toggle (defaults to "Idea").
      await page.getByRole("button", { name: "Bug" }).click();
      await page.getByLabel("Title").fill(bugTitle);
      await page.getByRole("button", { name: "Submit" }).click();

      // Confirmation + the new item appears in the list, badged as a Bug.
      await expect(page.getByText("Thank you for your feedback!")).toBeVisible({ timeout: 10_000 });
      const portalCard = page.locator("div").filter({ hasText: bugTitle }).last();
      await expect(portalCard.getByText("Bug", { exact: true })).toBeVisible();

      // ── 3. Open the internal feedback board ────────────────────────────────
      await page.goto(`${base}/feedback`);
      await page.waitForLoadState("networkidle");

      await expect(page.getByText(bugTitle)).toBeVisible({ timeout: 10_000 });

      // Filter to Bugs to isolate the row unambiguously.
      await page.getByRole("button", { name: "Bugs" }).click();
      // .first() grabs the outermost matching div — the full grid row, which
      // spans the title column and the action column as sibling children.
      // (.last() would resolve to the innermost div, i.e. just the title
      // column, missing the action column entirely.)
      const row = page.locator("div").filter({ hasText: bugTitle }).first();

      // The row shows the Bug type badge and a "Promote to roadmap" action —
      // NOT an opportunity-link picker (that's the idea-only path).
      await expect(row.getByText("Promote to roadmap")).toBeVisible();
      await expect(row.getByText("Link opportunity")).not.toBeVisible();

      // ── 4. Promote directly to the roadmap (NOW horizon) ───────────────────
      await row.getByText("Promote to roadmap").click();
      await page.getByRole("button", { name: "Now", exact: true }).click();

      // The action column now shows the "On roadmap" confirmation.
      await expect(row.getByText(/On roadmap \(Now\)/i)).toBeVisible({ timeout: 10_000 });

      // ── 5. Verify it appears on the roadmap, Bug-badged, in NOW ────────────
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");

      const roadmapCard = page.locator("div").filter({ hasText: bugTitle }).last();
      await expect(roadmapCard.getByText("Bug", { exact: true })).toBeVisible({ timeout: 10_000 });
    }
  );
});
