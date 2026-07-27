/**
 * Solution Plan & Discussion functional spec.
 *
 * Journey: Create opportunity → navigate to detail → add solution →
 *          expand solution card → post a Comment → post a Plan update →
 *          verify the Plan is pinned as "Current Plan" and both entries
 *          appear in the thread.
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
      await page.getByRole("link", { name: oppTitle }).click();
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { name: oppTitle })).toBeVisible();

      // ── 4. Add a solution ─────────────────────────────────────────────────
      await page.getByRole("button", { name: "Add Solution" }).click();
      await page.getByLabel("Title").fill(solTitle);
      await page.getByRole("button", { name: "Add Solution" }).last().click();

      await expect(page.getByText(solTitle)).toBeVisible({ timeout: 10_000 });

      // ── 5. Expand the solution card ────────────────────────────────────────
      await page.getByRole("button", { name: "Expand" }).click();

      // Plan & Discussion section is present but empty.
      await expect(page.getByText("Plan & Discussion")).toBeVisible();
      await expect(page.getByText("No plan or comments yet.")).toBeVisible();

      // ── 6. Post a regular comment (default type) ────────────────────────────
      await page.getByRole("button", { name: "Add Comment" }).click();
      await page.getByPlaceholder("Write a comment or plan update…").fill(commentBody);
      await page.getByRole("button", { name: "Post" }).click();

      // Comment appears in the thread; empty-state message is gone.
      await expect(page.getByText(commentBody)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("No plan or comments yet.")).not.toBeVisible();
      // No "Current Plan" pin yet — only a COMMENT has been posted.
      await expect(page.getByText("Current Plan")).not.toBeVisible();

      // ── 7. Post a plan update ────────────────────────────────────────────────
      await page.getByRole("button", { name: "Add Comment" }).click();
      await page.getByPlaceholder("Write a comment or plan update…").fill(planBody);
      await page
        .locator('[role="combobox"]')
        .filter({ hasText: "Comment" })
        .click();
      await page.getByRole("option", { name: "Plan update" }).click();
      await page.getByRole("button", { name: "Post" }).click();

      // ── 8. Verify the plan is pinned as "Current Plan" and both entries
      //       remain visible in the thread below.
      const pinnedPlan = page.getByTestId("current-plan");
      await expect(pinnedPlan).toBeVisible({ timeout: 10_000 });
      await expect(pinnedPlan).toContainText("Current Plan");
      await expect(pinnedPlan).toContainText(planBody);

      // Thread count reflects both posts.
      await expect(page.getByText("(2)", { exact: true })).toBeVisible();

      // Both entries are still individually visible in the full thread.
      await expect(page.getByText(commentBody)).toBeVisible();
      await expect(page.getByText(planBody).first()).toBeVisible();
    }
  );
});
