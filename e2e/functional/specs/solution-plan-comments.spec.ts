/**
 * Solution Current Plan + shared Discussion functional spec.
 *
 * Journey: Create opportunity → navigate to detail → add solution →
 *          open the solution's sidebar panel → post an ordinary shared
 *          Discussion comment → post a specialized Plan update → verify the
 *          Plan is pinned as "Current Plan" without duplicating the ordinary
 *          comment → approve the plan → reject it (a
 *          decision can be changed at any time).
 *
 * Both surfaces live in the Solution sidebar panel (not an expanding card) —
 * the card in the Solutions tab is a compact summary row whose title opens
 * this panel, matching every other entity's detail-panel pattern.
 */
import { test, expect } from "../fixtures/index";
import pg from "pg";

const S = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";

test.describe("Solution Current Plan + shared Discussion", () => {
  test(
    "ordinary discussion stays separate while the current plan remains pinnable and approvable",
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
      const detailHref = await page.getByRole("link", { name: "Open full page" }).getAttribute("href");
      expect(detailHref).toBeTruthy();
      if (!detailHref) throw new Error("Opportunity detail link is missing its href");
      await page.goto(new URL(detailHref, page.url()).toString());
      await expect(page.getByRole("heading", { name: oppTitle })).toBeVisible({ timeout: 10_000 });

      // ── 4. Add a solution ─────────────────────────────────────────────────
      await page.getByRole("button", { name: "Add Solution" }).click();
      await page.getByLabel("Title").fill(solTitle);
      await page.getByRole("button", { name: "Add Solution" }).last().click();

      await expect(page.getByText(solTitle)).toBeVisible({ timeout: 10_000 });

      // ── 5. Open the solution's sidebar panel ────────────────────────────────
      await page.getByRole("button", { name: solTitle, exact: true }).click();
      const panel = page.locator('[data-slot="sheet-content"]');
      await expect(panel).toBeVisible();

      // Specialized plans and ordinary shared comments are distinct surfaces.
      await expect(panel.getByText("Current Plan", { exact: true })).toBeVisible();
      await expect(panel.getByText("No plan yet.")).toBeVisible();
      await expect(panel.getByRole("heading", { name: "Discussion" })).toBeVisible();
      await expect(panel.getByText("No comments yet.")).toBeVisible();

      // ── 6. Post an ordinary shared Discussion comment ──────────────────────
      await panel.getByLabel("Add comment").fill(commentBody);
      await panel.getByRole("button", { name: "Post comment" }).click();

      // Comment appears exactly once and never enters the specialized plan list.
      await expect(panel.getByText(commentBody)).toBeVisible({ timeout: 10_000 });
      await expect(panel.getByText(commentBody)).toHaveCount(1);
      await expect(panel.getByText("No comments yet.")).not.toBeVisible();
      await expect(panel.getByText("No plan yet.")).toBeVisible();
      await expect(panel.getByTestId("current-plan")).not.toBeVisible();

      // ── 7. Post a plan update ────────────────────────────────────────────────
      await panel.getByRole("button", { name: "Add Plan Update" }).click();
      await panel.getByPlaceholder("Write a plan update…").fill(planBody);
      await panel.getByRole("button", { name: "Post plan update" }).click();

      // ── 8. Verify the plan is pinned and the ordinary comment remains once.
      const pinnedPlan = panel.getByTestId("current-plan");
      await expect(pinnedPlan).toBeVisible({ timeout: 10_000 });
      await expect(pinnedPlan).toContainText("Current Plan");
      await expect(pinnedPlan).toContainText(planBody);

      await expect(panel.getByText(commentBody)).toHaveCount(1);
      await expect(panel.getByText(planBody).first()).toBeVisible();

      // Generic browser mutations must not touch the specialized plan row.
      if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for plan isolation verification");
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      const { rows: [persistedPlan] } = await pool.query<{ id: string; body: string }>(`
        SELECT c.id, c.body FROM "${S}".comments c
        JOIN "${S}".solution_plan_proposals p ON p.comment_id = c.id
        WHERE c.body = $1
      `, [planBody]);
      expect(persistedPlan).toBeTruthy();
      const genericPatch = await page.request.patch(`/api/comments/${persistedPlan.id}`, { data: { action: "edit", body: "Generic overwrite" } });
      const genericDelete = await page.request.delete(`/api/comments/${persistedPlan.id}`);
      expect(genericPatch.status()).toBe(404);
      expect(genericDelete.status()).toBe(404);
      expect((await pool.query<{ body: string }>(`SELECT body FROM "${S}".comments WHERE id = $1`, [persistedPlan.id])).rows[0].body).toBe(planBody);
      await pool.end();

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
