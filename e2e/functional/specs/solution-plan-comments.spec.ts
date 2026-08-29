/**
 * Solution Plan & Discussion functional spec.
 *
 * Journey: Create opportunity → navigate to detail → add solution →
 *          open the solution's sidebar panel → post a Comment → post a Plan
 *          update → verify the Plan is pinned as "Current Plan" and both
 *          entries appear in the thread → approve the plan → reject it (a
 *          decision can be changed at any time).
 *
 * Plan & Discussion lives in the Solution sidebar panel (not an expanding
 * card) — the card in the Solutions tab is a compact summary row whose title
 * opens this panel, matching every other entity's detail-panel pattern.
 */
import { test, expect } from "../fixtures/index";

test.describe("Solution Plan & Discussion", () => {
  test(
    "create solution → add comment → add plan → plan is pinned",
    async ({ page, base }) => {
      const ts = Date.now();
      const oppTitle = `E2E Opportunity ${ts}`;
      const solTitle = `E2E Solution ${ts}`;
      const commentBody = `E2E first thoughts on this ${ts}`;
      const planBody = `E2E proposed plan: ship behind a flag ${ts}`;

      // ── 1. Navigate to Discovery board ────────────────────────────────────
      await page.goto(`${base}/discovery`);
      await page.waitForLoadState("networkidle");

      // ── 2. Create an opportunity ────────────────────────────────────────────
      await page.getByRole("button", { name: /Add opportunity/i }).first().click();
      await page.getByLabel("Title").fill(oppTitle);
      await page.getByRole("button", { name: "Create Opportunity" }).click();

      await expect(page.getByText(oppTitle)).toBeVisible({ timeout: 15_000 });

      // ── 3. Navigate to the opportunity detail page ─────────────────────────
      await page.getByRole("button", { name: oppTitle, exact: true }).click();
      await page.getByRole("link", { name: "Open full page" }).click();
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { name: oppTitle })).toBeVisible();

      // ── 4. Add a solution ─────────────────────────────────────────────────
      await page.getByRole("button", { name: "Add Solution" }).click();
      await page.getByLabel("Title").fill(solTitle);
      await page.getByRole("button", { name: "Add Solution" }).last().click();

      await expect(page.getByText(solTitle)).toBeVisible({ timeout: 10_000 });

      // ── 5. Open the solution's sidebar panel ────────────────────────────────
      await page.getByRole("button", { name: solTitle, exact: true }).click();
      const panel = page.locator('[data-slot="sheet-content"]');
      await expect(panel).toBeVisible();

      // Plan & Discussion section is present but empty.
      await expect(panel.getByText("Plan & Discussion")).toBeVisible();
      await expect(panel.getByText("No plan or comments yet.")).toBeVisible();

      // ── 6. Post a regular comment (default type) ────────────────────────────
      await panel.getByRole("button", { name: "Add Comment" }).click();
      await panel.getByPlaceholder("Write a comment or plan update…").fill(commentBody);
      await panel.getByRole("button", { name: "Post" }).click();

      // Comment appears in the thread; empty-state message is gone.
      await expect(panel.getByText(commentBody)).toBeVisible({ timeout: 10_000 });
      await expect(panel.getByText("No plan or comments yet.")).not.toBeVisible();
      // No "Current Plan" pin yet — only a COMMENT has been posted.
      await expect(panel.getByText("Current Plan")).not.toBeVisible();

      // ── 7. Post a plan update ────────────────────────────────────────────────
      await panel.getByRole("button", { name: "Add Comment" }).click();
      await panel.getByPlaceholder("Write a comment or plan update…").fill(planBody);
      await panel
        .locator('[role="combobox"]')
        .filter({ hasText: "Comment" })
        .click();
      // base-ui renders the listbox in a portal the panel's Sheet stacks over,
      // so a pointer click on the option is intercepted by the overlay (see
      // launch-tiers.spec for the same workaround). Activate by keyboard.
      const planUpdateOption = page.getByRole("option", { name: "Plan update" });
      await expect(planUpdateOption).toBeVisible({ timeout: 10_000 });
      await planUpdateOption.press("Enter");
      await panel.getByRole("button", { name: "Post" }).click();

      // ── 8. Verify the plan is pinned as "Current Plan" and both entries
      //       remain visible in the thread below.
      const pinnedPlan = panel.getByTestId("current-plan");
      await expect(pinnedPlan).toBeVisible({ timeout: 10_000 });
      await expect(pinnedPlan).toContainText("Current Plan");
      await expect(pinnedPlan).toContainText(planBody);

      // Thread count reflects both posts.
      await expect(panel.getByText("(2)", { exact: true })).toBeVisible();

      // Both entries are still individually visible in the full thread.
      await expect(panel.getByText(commentBody)).toBeVisible();
      await expect(panel.getByText(planBody).first()).toBeVisible();

      // ── 9. New plans start Pending ──────────────────────────────────────────
      const planStatusBadge = panel.getByTestId("plan-status-badge");
      await expect(planStatusBadge).toHaveText("Pending");

      // ── 10. Approve the plan ────────────────────────────────────────────────
      await pinnedPlan.getByRole("button", { name: "Approve" }).click();
      await expect(planStatusBadge).toHaveText("Approved", { timeout: 10_000 });
      // Approve button reflects the current decision (disabled once active).
      await expect(pinnedPlan.getByRole("button", { name: "Approve" })).toBeDisabled();
      await expect(pinnedPlan.getByRole("button", { name: "Reject" })).toBeEnabled();

      // ── 11. A decision can be changed — reject it instead ───────────────────
      await pinnedPlan.getByRole("button", { name: "Reject" }).click();
      await expect(planStatusBadge).toHaveText("Rejected", { timeout: 10_000 });
      await expect(pinnedPlan.getByRole("button", { name: "Reject" })).toBeDisabled();
      await expect(pinnedPlan.getByRole("button", { name: "Approve" })).toBeEnabled();
    }
  );
});
