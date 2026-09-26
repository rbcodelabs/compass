/**
 * Launch Tiers + Checklists + Positioning Brief functional spec.
 *
 * Journey (authenticated, flag ON): add a roadmap item → open it via the
 *          card's "Launch" menu action → the roadmap-item panel's Launch
 *          section shows the tier picker → pick the Silent Launch tier
 *          (auto-seeds a 2-item checklist and moves the item to LAUNCHING) →
 *          the panel re-renders in the checklist state showing "0/2 done" →
 *          toggle the first item to Done → "1/2 done" → create the
 *          positioning brief → lands on the docs editor with the GTM
 *          template content → back on the board the card is in the Launching
 *          column with a "1/2" launch chip.
 *
 * Journey (public): enable the public roadmap, then in a fresh unauthenticated
 *          context confirm the item appears under the portal's "Launching"
 *          column.
 *
 * Journey (flag OFF — the default): confirms the whole marketing-launch
 *          surface (card menu item/chip, panel Launch section, LAUNCHING/
 *          LAUNCHED board columns) is absent when Workspace.launchWorkflowEnabled
 *          is off, per Compass solution 8303c3df-498d-4503-b92b-c7fd7a0fa62d.
 *
 * This is the first user-facing journey for the GTM launch UI (the feature
 * shipped MCP-only in PR #72), so it's a new spec. The launch surface reuses
 * the shared entity-detail panel rather than a bespoke panel type, so this
 * drives the same panel the detail-panel spec covers, just its Launch section.
 */
import { test, expect } from "../fixtures/index";
import type { Page } from "@playwright/test";

/**
 * The Settings → Marketing launch toggle has an accessible name via
 * data-testid (see launch-workflow-settings-panel.tsx), same pattern as the
 * pre-existing portal-toggle-roadmap helper below. Returns the toggle's state
 * *before* this call so the caller can restore it afterward.
 */
async function setLaunchWorkflowEnabled(page: Page, base: string, enabled: boolean): Promise<boolean> {
  await page.goto(`${base}/settings`);
  await page.waitForLoadState("networkidle");
  const toggle = page.getByTestId("launch-workflow-toggle");
  const wasEnabled = (await toggle.getAttribute("aria-checked")) === "true";
  if (wasEnabled !== enabled) {
    await toggle.click();
    await page.waitForLoadState("networkidle");
  }
  return wasEnabled;
}

test.describe("Launch tiers, checklist & positioning brief", () => {
  test("flag off by default: no Launch menu item, no Launch panel section, no LAUNCHING/LAUNCHED columns", async ({ page, base }) => {
    const wasEnabled = await setLaunchWorkflowEnabled(page, base, false);

    try {
      const ts = Date.now();
      const itemTitle = `E2E No-Launch Item ${ts}`;

      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");

      // No LAUNCHING/LAUNCHED column headers on the internal board.
      await expect(page.getByRole("heading", { name: "Launching", exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Launched", exact: true })).toHaveCount(0);

      await page.getByRole("button", { name: "Add item" }).nth(1).click();
      await page.getByLabel("Title").fill(itemTitle);
      await page.getByRole("button", { name: "Add Item", exact: true }).click();

      const card = page.locator('[data-slot="card"]').filter({ hasText: itemTitle });
      await expect(card).toBeVisible({ timeout: 10_000 });

      // The card menu has no "Launch" item, and no launch progress chip.
      await card.hover();
      await card.getByLabel("Card actions").click();
      // Wait for the menu to actually open. Asserting "no Launch item" against
      // a menu that hasn't rendered yet passes vacuously, and an Escape sent
      // before it opens is lost — the menu then opens late and covers the card.
      const cardMenu = page.getByRole("menu");
      await expect(cardMenu.getByRole("menuitem", { name: "Edit" })).toBeVisible();
      await expect(cardMenu.getByRole("menuitem", { name: "Launch" })).toHaveCount(0);
      // Close the menu before opening the panel below.
      await page.keyboard.press("Escape");
      await expect(cardMenu).toHaveCount(0);

      // Open the panel directly (there's no "Launch" menu action to reach it
      // by anymore) and confirm the Launch section itself is gone too.
      await card.getByText(itemTitle).click();
      const panel = page.locator('[data-slot="sheet-content"]');
      await expect(panel).toBeVisible();
      await expect(panel.getByText("Launch", { exact: true })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: /Set launch tier/ })).toHaveCount(0);
    } finally {
      await setLaunchWorkflowEnabled(page, base, wasEnabled);
    }
  });

  test(
    "flag on: card Launch menu → tier picker auto-seeds → toggle item → brief → portal Launching column",
    async ({ page, base, orgSlug, workspaceSlug, browser, baseURL }) => {
      const wasLaunchWorkflowEnabled = await setLaunchWorkflowEnabled(page, base, true);

      const ts = Date.now();
      const itemTitle = `E2E Launch Item ${ts}`;

      // The roadmap board + panel both mount @dnd-kit, which emits a known,
      // pre-existing hydration-mismatch warning (see canvas/detail-panel specs)
      // — filter it so the spec still catches genuinely new console errors.
      const KNOWN = ["DndDescribedBy"];
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        if (KNOWN.some((s) => text.includes(s))) return;
        consoleErrors.push(text);
      });
      page.on("pageerror", (err) => consoleErrors.push(err.message));

      const panel = page.locator('[data-slot="sheet-content"]');

      // ── 1. Add a roadmap item in NEXT (NOW is decision-gated) ──────────────
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: "Add item" }).nth(1).click();
      await page.getByLabel("Title").fill(itemTitle);
      // exact — otherwise this also matches the still-collapsed "Add item"
      // triggers in the other columns (substring, case-insensitive by default).
      await page.getByRole("button", { name: "Add Item", exact: true }).click();

      const card = page.locator('[data-slot="card"]').filter({ hasText: itemTitle });
      await expect(card).toBeVisible({ timeout: 10_000 });

      // ── 2. Open the panel via the card's "Launch" menu action ──────────────
      await card.hover();
      await card.getByLabel("Card actions").click();
      await page.getByRole("menuitem", { name: "Launch" }).click();

      await expect(page).toHaveURL(/detail=roadmapItem/, { timeout: 10_000 });
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(itemTitle);

      // ── 3. Launch section shows the tier picker; pick Silent Launch (2 items)
      const tierButton = panel.getByRole("button", { name: "Set launch tier: Silent Launch" });
      await expect(tierButton).toBeVisible();
      await tierButton.click();

      // The picker calls setLaunchTier (auto-seeds a checklist + flips the item
      // to LAUNCHING) then refreshes the panel into the checklist state.
      await expect(panel.getByText(/0\/2 done/)).toBeVisible({ timeout: 15_000 });

      // ── 4. Toggle the first checklist item to Done → progress becomes 1/2 ──
      // Target a checklist-item Select by its current "Pending" label rather
      // than positionally — the panel also renders the PanelTitle's horizon
      // status editor as a combobox, so a bare nth(0) could hit the wrong one.
      const firstStatus = panel.getByRole("combobox").filter({ hasText: "Pending" }).first();
      await expect(firstStatus).toBeEnabled({ timeout: 10_000 });
      await firstStatus.click();
      // This used to need keyboard activation: the panel layer's sheet painted
      // over base-ui's portaled listbox, so a pointer click was intercepted by
      // the overlay. Fixed by moving the Select positioner to the popup layer
      // (select.tsx); a plain click now works and guards against that
      // regressing.
      await page.getByRole("option", { name: "Done" }).click();

      await expect(panel.getByText(/1\/2 done/)).toBeVisible({ timeout: 15_000 });

      // ── 5. Create the positioning brief → navigates to the docs editor with
      //       the GTM template content ─────────────────────────────────────
      await panel.getByRole("button", { name: "Create positioning brief" }).click();
      await expect(page).toHaveURL(/\/docs\/[^/?#]+/, { timeout: 15_000 });
      await page.waitForLoadState("networkidle");
      // GTM_POSITIONING_BRIEF_TEMPLATE opens with a "Problem Statement" section.
      await expect(page.getByText("Problem Statement").first()).toBeVisible({ timeout: 15_000 });

      // ── 6. Back on the board, the card is now in the Launching column with a
      //       "1/2" launch chip ───────────────────────────────────────────────
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");

      // The Launching column exists and the item's chip reflects 1-of-2 done.
      const launchChip = page.locator('[title="Launch checklist: 1 of 2 done"]');
      await expect(launchChip).toBeVisible({ timeout: 10_000 });
      await expect(launchChip).toContainText("1/2");

      // ── 7. Public portal: enable the roadmap, then confirm the item shows
      //       under the "Launching" column in an unauthenticated context ─────
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");
      // The public-roadmap toggle has no accessible name (see portal.spec.ts),
      // so locate it by its stable data-testid rather than a positional index.
      const toggle = page.getByTestId("portal-toggle-roadmap");
      const wasEnabled = (await toggle.getAttribute("aria-checked")) === "true";
      if (!wasEnabled) {
        await toggle.click();
        await page.waitForLoadState("networkidle");
      }

      const portalUrl = `${baseURL}/portal/${orgSlug}/${workspaceSlug}/roadmap`;
      const anonContext = await browser.newContext({ storageState: undefined });
      const anonPage = await anonContext.newPage();
      await anonPage.goto(portalUrl);
      await anonPage.waitForLoadState("networkidle");

      await expect(anonPage.getByText("This roadmap is not public")).not.toBeVisible({ timeout: 5_000 });
      // The public "Launching" column header (a <span>, not a heading role) and
      // our item are both present.
      await expect(anonPage.getByText("Launching", { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(anonPage.getByText(itemTitle)).toBeVisible({ timeout: 10_000 });

      await anonContext.close();

      // ── 8. Cleanup: restore the portal + launch-workflow toggles ───────────
      if (!wasEnabled) {
        const stillOn = (await toggle.getAttribute("aria-checked")) === "true";
        if (stillOn) {
          await toggle.click();
          await page.waitForLoadState("networkidle");
        }
      }
      await setLaunchWorkflowEnabled(page, base, wasLaunchWorkflowEnabled);

      expect(consoleErrors).toEqual([]);
    }
  );
});
