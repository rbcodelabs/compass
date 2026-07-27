/**
 * Assumption ↔ Experiment linking functional spec.
 *
 * Journey: Create opportunity → solution → assumption → click "Test this
 *          assumption" CTA on the OST tree → land on Experiments with the
 *          assumption picker pre-filled → create the experiment → verify
 *          the OST tree now shows the linked experiment under the
 *          assumption instead of "No experiments yet".
 *
 * This exercises the UI-layer gap the createExperiment server action already
 * supported (assumptionId has been wired end-to-end since the action was
 * written — see __tests__/actions/experiments.test.ts) but that no UI
 * surface ever collected before this feature: the OST tree had no CTA to
 * start a linked experiment, and create-experiment-form had no assumption
 * picker at all.
 */
import { test, expect } from "../fixtures/index";

test.describe("Assumption ↔ Experiment linking", () => {
  test(
    "test this assumption CTA pre-fills the experiment form and links back",
    async ({ page, base }) => {
      const ts = Date.now();
      const oppTitle = `E2E AEL Opportunity ${ts}`;
      const solTitle = `E2E AEL Solution ${ts}`;
      const assumptionTitle = `E2E AEL Assumption ${ts}`;
      const expTitle = `E2E AEL Experiment ${ts}`;

      // ── 1. Create an opportunity ──────────────────────────────────────────
      await page.goto(`${base}/discovery`);
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: /Add opportunity/i }).first().click();
      await page.getByLabel("Title").fill(oppTitle);
      await page.getByRole("button", { name: "Create Opportunity" }).click();
      await expect(page.getByText(oppTitle)).toBeVisible({ timeout: 15_000 });

      await page.getByRole("link", { name: oppTitle }).click();
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { name: oppTitle })).toBeVisible();

      // ── 2. Add a solution ─────────────────────────────────────────────────
      await page.getByRole("button", { name: "Add Solution" }).click();
      await page.getByLabel("Title").fill(solTitle);
      await page.getByRole("button", { name: "Add Solution" }).last().click();
      await expect(page.getByText(solTitle)).toBeVisible({ timeout: 10_000 });

      // ── 3. Expand the solution card and add an assumption ─────────────────
      await page.getByRole("button", { name: "Expand" }).click();
      await page.getByRole("button", { name: "Add Assumption" }).click();
      await page.getByPlaceholder("Assumption title").fill(assumptionTitle);
      await page.getByRole("button", { name: "Add", exact: true }).click();

      // revalidatePath doesn't reliably refresh in-place client state in dev
      // mode (same caveat as discovery-roadmap.spec.ts) — hard reload to see
      // the server-rendered assumption, then re-expand (expanded state resets).
      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "Expand" }).click();
      await expect(page.getByText(assumptionTitle)).toBeVisible({ timeout: 10_000 });

      // ── 4. Switch to the OST Tree tab ──────────────────────────────────────
      await page.getByRole("tab", { name: "OST Tree" }).click();
      await expect(page.getByText(assumptionTitle)).toBeVisible({ timeout: 10_000 });

      // "No experiments yet" + the new CTA should be visible for this
      // brand-new, unlinked assumption.
      await expect(page.getByText("No experiments yet")).toBeVisible();
      const cta = page.getByRole("link", { name: "Test this assumption →" });
      await expect(cta).toBeVisible();

      // ── 5. Follow the CTA to the Experiments page ──────────────────────────
      await cta.click();
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveURL(/\/experiments\?assumptionId=/);

      // The create-experiment form should already be open (prefilled), with
      // the assumption picker showing our assumption pre-selected.
      await expect(page.getByText("New Experiment")).toBeVisible();
      await expect(
        page.getByRole("combobox").filter({ hasText: assumptionTitle })
      ).toBeVisible({ timeout: 10_000 });

      // ── 6. Fill in and submit the experiment ────────────────────────────────
      await page.getByLabel("Title").fill(expTitle);
      await page.getByLabel("Hypothesis").fill("We believe linking assumptions works.");
      await page.getByLabel("Method").fill("Manual QA pass.");
      await page.getByLabel("Kill Condition").fill("Abandon if the link never appears.");
      await page.getByRole("button", { name: "Create Experiment" }).click();

      await expect(page.getByText(expTitle)).toBeVisible({ timeout: 15_000 });

      // ── 7. Verify the OST tree now shows the linked experiment ─────────────
      await page.goto(`${base}/discovery`);
      await page.getByRole("link", { name: oppTitle }).click();
      await page.waitForLoadState("networkidle");
      await page.getByRole("tab", { name: "OST Tree" }).click();

      await expect(page.getByText(assumptionTitle)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("link", { name: expTitle })).toBeVisible({
        timeout: 10_000,
      });
    }
  );
});
