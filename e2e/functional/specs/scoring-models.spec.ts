/**
 * Scoring Models functional spec.
 *
 * Journey: Org Settings → create a WEIGHTED_SUM scoring model with two
 *          metrics (Reach +, Effort -) → Workspace Settings → activate that
 *          same model for both the Opportunity and Solution slots (the two
 *          picks are independent, but nothing stops one model backing both)
 *          → open the seeded baseline opportunity → the Scoring tab appears
 *          → enter raw values → save → verify the computed normalized score
 *          persists across a reload → then do the same for the opportunity's
 *          nested baseline solution, whose Scoring section lives in its own
 *          sidebar panel rather than a tab (Solutions have no detail route).
 *
 * The seeded e2e user (dev@localhost.dev) is both an organization ADMIN and
 * a workspace ADMIN (see e2e/functional/fixtures/seed-e2e.ts), so this
 * single spec can exercise the full org-author → workspace-select →
 * member-score flow without needing multiple test users.
 *
 * Metric row inputs share label text across rows ("Key", "Label", "Min",
 * "Max", "Weight", "Direction" repeat once per metric), so this spec
 * targets them by the deterministic per-row element IDs
 * (`create-metric-<index>-<field>`) rather than getByLabel, which would be
 * ambiguous with more than one metric row on the page.
 */
import { test, expect } from "../fixtures/index";
import { openFullPage } from "../fixtures/full-page";
import type { Locator, Page } from "@playwright/test";

/**
 * Open the Solution panel's collapsible "Scoring" section if it isn't
 * already open. Its open/closed state is a cookie-backed preference (see
 * lib/panel-section-state.ts) that survives a reload, so unconditionally
 * clicking the trigger a second time — e.g. after reopening the panel post
 * -reload — would toggle it shut instead of leaving it open.
 *
 * The panel's entity data (including which sections are collapsible/open)
 * loads asynchronously after the sheet shell itself mounts, so the trigger
 * briefly doesn't exist at all (`PanelSkeleton`). Checking `getByLabel
 * ("Reach")` as a same-tick proxy for "already open" races that: it reads
 * false during the skeleton, so this function clicks the trigger — but
 * Playwright's click() auto-waits for the trigger to appear, and by the time
 * it does, the section has already rendered open (per the cookie), so the
 * click actually closes it. Waiting for the trigger itself and reading its
 * real `aria-expanded` state sidesteps the race entirely.
 */
async function ensureSolutionScoringSectionOpen(panel: Locator) {
  const trigger = panel.getByRole("button", { name: "Scoring", exact: true });
  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute("aria-expanded")) === "true") return;
  await trigger.click();
  await expect(panel.getByLabel("Reach")).toBeVisible();
}

/**
 * Open the seeded baseline solution's sidebar panel by clicking its title.
 *
 * The panel's open/closed state is a deep link encoded in the URL (the
 * `detail` param — see `PANEL_PARAM` in `components/panels/panel-context.tsx`),
 * so it survives a `page.reload()` on its own: the panel reopens once the app
 * rehydrates and replays the query param. That replay is asynchronous, so an
 * immediate `isVisible()` check right after reload races it — too early to
 * see the panel open, but the panel can still finish opening moments later,
 * right as the fallback path clicks the "Solutions" tab underneath it. The
 * modal sheet then intercepts that click and the test hangs until timeout.
 * Give the deep link a bounded window to replay before falling back to
 * opening the panel by hand.
 */
async function openBaselineSolutionPanel(page: Page): Promise<Locator> {
  const panel = page.locator('[data-slot="sheet-content"]');
  const alreadyOpen = await panel
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (alreadyOpen) return panel;

  await page.getByRole("tab", { name: /^Solutions/ }).click();
  await page.getByRole("button", { name: "E2E Baseline Solution", exact: true }).click();
  await expect(panel).toBeVisible();
  return panel;
}

test.describe("Scoring Models", () => {
  test(
    "create scoring model → activate for workspace → score an opportunity and its nested solution",
    async ({ page, base, orgSlug }) => {
      const ts = Date.now();
      const modelName = `E2E RICE ${ts}`;

      // ── 1. Create a scoring model in Org Settings ─────────────────────────
      await page.goto(`/${orgSlug}/settings`);
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: "Add scoring model" }).click();
      await page.getByLabel("Name").fill(modelName);
      // Formula Type defaults to Weighted Sum — leave as-is.

      // First metric row (pre-populated by the form): Reach, POSITIVE.
      await page.locator("#create-metric-0-key").fill("reach");
      await page.locator("#create-metric-0-label").fill("Reach");
      await page.locator("#create-metric-0-min").fill("0");
      await page.locator("#create-metric-0-max").fill("10");
      await page.locator("#create-metric-0-weight").fill("1");
      // Direction already defaults to Positive.

      // Second metric row: Effort, NEGATIVE.
      await page.getByRole("button", { name: "Add metric" }).click();
      await page.locator("#create-metric-1-key").fill("effort");
      await page.locator("#create-metric-1-label").fill("Effort");
      await page.locator("#create-metric-1-min").fill("0");
      await page.locator("#create-metric-1-max").fill("10");
      await page.locator("#create-metric-1-weight").fill("1");
      await page.locator("#create-metric-1-direction").click();
      await page.getByRole("option", { name: "Negative" }).click();

      await page.getByRole("button", { name: "Create Scoring Model" }).click();

      // New model row appears in the list.
      await expect(page.getByText(modelName)).toBeVisible({ timeout: 15_000 });

      // Confirm it persisted server-side.
      await page.reload();
      await page.waitForLoadState("load");
      await expect(page.getByText(modelName)).toBeVisible({ timeout: 10_000 });

      // ── 2. Activate the model for both independent workspace slots ─────────
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");

      // `getByLabel` matches by substring, so the plain label needs `exact`
      // now that "Active scoring model for Solutions" also exists on this
      // page — without it, this locator resolves to both pickers.
      await page.getByLabel("Active scoring model", { exact: true }).click();
      await page.getByRole("option", { name: modelName }).click();

      await page.getByLabel("Active scoring model for Solutions").click();
      await page.getByRole("option", { name: modelName }).click();

      // No explicit saving indicator for either select — give the server
      // actions a moment, then reload to verify both persisted.
      await page.waitForTimeout(1_500);
      await page.reload();
      await page.waitForLoadState("load");
      await expect(page.getByLabel("Active scoring model", { exact: true })).toContainText(modelName, {
        timeout: 10_000,
      });
      await expect(page.getByLabel("Active scoring model for Solutions")).toContainText(modelName, {
        timeout: 10_000,
      });

      // ── 3. Score the seeded baseline opportunity ────────────────────────────
      await page.goto(`${base}/discovery`);
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: "E2E Baseline Opportunity", exact: true }).click();
      // Both surfaces now expose Scoring. Wait for the destination, not the
      // outgoing panel's identical tab, before interacting with it.
      await openFullPage(page);
      await expect(page.locator('[data-slot="opportunity-detail"][data-variant="page"]')).toBeVisible();

      await page.getByRole("tab", { name: "Scoring" }).click();

      await expect(page.getByText(modelName)).toBeVisible();

      const reachInput = page.getByLabel("Reach");
      const effortInput = page.getByLabel("Effort");
      await reachInput.fill("8");
      await effortInput.fill("2");

      // Live preview updates before saving: rawScore = 8 - 2 = 6.
      await expect(page.getByText(/Raw score: 6\.00/)).toBeVisible();

      await page.getByRole("button", { name: "Save Score" }).click();

      // "Last saved" panel appears once the server action resolves.
      await expect(page.getByText("Last saved")).toBeVisible({ timeout: 15_000 });

      // ── 4. Verify the score persisted across a reload ───────────────────────
      await page.reload();
      await page.waitForLoadState("load");
      await page.getByRole("tab", { name: "Scoring" }).click();

      await expect(page.getByLabel("Reach")).toHaveValue("8");
      await expect(page.getByLabel("Effort")).toHaveValue("2");
      await expect(page.getByRole("button", { name: "Update Score" })).toBeVisible();

      // ── 5. Score the seeded baseline solution nested under it ──────────────
      // Solutions have no detail route of their own, so their Scoring surface
      // is a collapsible section in the sidebar panel opened from the
      // Solutions tab, not a tab of its own (contrast with the opportunity
      // flow above).
      const solutionPanel = await openBaselineSolutionPanel(page);
      await ensureSolutionScoringSectionOpen(solutionPanel);

      const solutionReachInput = solutionPanel.getByLabel("Reach");
      const solutionEffortInput = solutionPanel.getByLabel("Effort");
      await solutionReachInput.fill("7");
      await solutionEffortInput.fill("3");

      // Live preview updates before saving: rawScore = 7 - 3 = 4.
      await expect(solutionPanel.getByText(/Raw score: 4\.00/)).toBeVisible();

      await solutionPanel.getByRole("button", { name: "Save Score" }).click();
      await expect(solutionPanel.getByText("Last saved")).toBeVisible({ timeout: 15_000 });

      // ── 6. Verify the solution's score persisted across a reload ───────────
      await page.reload();
      await page.waitForLoadState("load");

      const reopenedSolutionPanel = await openBaselineSolutionPanel(page);
      await ensureSolutionScoringSectionOpen(reopenedSolutionPanel);

      await expect(reopenedSolutionPanel.getByLabel("Reach")).toHaveValue("7");
      await expect(reopenedSolutionPanel.getByLabel("Effort")).toHaveValue("3");
      await expect(reopenedSolutionPanel.getByRole("button", { name: "Update Score" })).toBeVisible();
    }
  );
});

/**
 * Error-path journeys for the create form.
 *
 * These exist because the failures below used to surface as Next's opaque
 * "An error occurred in the Server Components render." — the actions threw,
 * and a thrown Server Action error loses its message in a production build.
 * The actions now return `{ ok: false, error, issues }`, and the form
 * pre-validates with the same pure rules, so each failure names what is wrong
 * and where.
 *
 * Note these assertions pass in `next dev` too, but the bug they guard only
 * ever manifested in a production build — dev forwards the real message.
 */
test.describe("Scoring Models — invalid input", () => {
  test("MULTIPLICATIVE with a zero minimum reports the specific reason and creates nothing", async ({
    page,
    orgSlug,
  }) => {
    const modelName = `E2E Invalid Min ${Date.now()}`;

    await page.goto(`/${orgSlug}/settings`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Add scoring model" }).click();
    await page.getByLabel("Name").fill(modelName);

    await page.getByRole("combobox", { name: "Formula Type" }).click();
    await page.getByRole("option", { name: /Multiplicative/ }).click();

    await page.locator("#create-metric-0-key").fill("reach");
    await page.locator("#create-metric-0-label").fill("Reach");
    await page.locator("#create-metric-0-min").fill("0");

    await page.getByRole("button", { name: "Create Scoring Model" }).click();

    // The real message, not the production mask.
    await expect(page.locator("#create-metric-0-min-error")).toContainText(
      /minValue greater than 0/,
      { timeout: 10_000 }
    );
    await expect(page.getByText(/An error occurred in the Server Components render/)).toHaveCount(0);
    // Surfaced at the offending field, not only as a banner.
    await expect(page.locator("#create-metric-0-min")).toHaveAttribute("aria-invalid", "true");

    // Nothing was persisted — no orphan model row.
    await page.reload();
    await page.waitForLoadState("load");
    await expect(page.getByText(modelName)).toHaveCount(0);
  });

  test("duplicate metric keys name the offending key and create nothing", async ({
    page,
    orgSlug,
  }) => {
    const modelName = `E2E Duplicate Key ${Date.now()}`;

    await page.goto(`/${orgSlug}/settings`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Add scoring model" }).click();
    await page.getByLabel("Name").fill(modelName);

    await page.locator("#create-metric-0-key").fill("reach");
    await page.locator("#create-metric-0-label").fill("Reach");

    await page.getByRole("button", { name: "Add metric" }).click();
    await page.locator("#create-metric-1-key").fill("reach");
    await page.locator("#create-metric-1-label").fill("Reach Again");

    await page.getByRole("button", { name: "Create Scoring Model" }).click();

    await expect(page.locator("#create-metric-1-key-error")).toContainText('"reach"', {
      timeout: 10_000,
    });
    await expect(page.getByText(/An error occurred in the Server Components render/)).toHaveCount(0);
    await expect(page.locator("#create-metric-1-key")).toHaveAttribute("aria-invalid", "true");

    // Previously this reached the DB: the parent model row was written and
    // only then did createMany trip the unique index, leaving a model with
    // zero metrics behind.
    await page.reload();
    await page.waitForLoadState("load");
    await expect(page.getByText(modelName)).toHaveCount(0);
  });

  test("selecting MULTIPLICATIVE raises an untouched zero minimum to 1", async ({
    page,
    orgSlug,
  }) => {
    await page.goto(`/${orgSlug}/settings`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Add scoring model" }).click();
    await expect(page.locator("#create-metric-0-min")).toHaveValue("0");

    await page.getByRole("combobox", { name: "Formula Type" }).click();
    await page.getByRole("option", { name: /Multiplicative/ }).click();

    // A default of 0 is invalid for this formula, so the form stops offering it.
    await expect(page.locator("#create-metric-0-min")).toHaveValue("1");
  });
});
