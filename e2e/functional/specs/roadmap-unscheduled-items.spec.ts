/**
 * Roadmap "Not yet on the roadmap" functional spec.
 *
 * Journey:
 *   1. Create a validated Solution via Discovery and a Bug via the public
 *      portal — neither is on the roadmap yet.
 *   2. On the roadmap Board, confirm both appear in the "Not yet on the
 *      roadmap" panel.
 *   3. Drag the Solution card onto the LATER column — confirm it lands there
 *      and disappears from the unscheduled panel.
 *   4. Use the Bug card's quick-add menu (no drag) to add it to NEXT —
 *      confirm it lands there too.
 *   5. Create a second Solution, switch to Timeline view, confirm it's
 *      listed as unscheduled there too, then drag it onto the Gantt chart
 *      area — confirm the schedule dialog opens, fill in dates, save, and
 *      confirm the item now renders as a bar on the Timeline.
 *
 * dnd-kit's PointerSensor needs real mouse movement (not a single jump) to
 * activate past its 8px activation-distance threshold, so drags here are
 * simulated with page.mouse.move/down/up rather than Playwright's built-in
 * dragTo (which doesn't reliably trigger pointer-sensor-based DnD).
 */
import { test, expect } from "../fixtures/index";
import type { Page } from "@playwright/test";

async function dragTo(page: Page, source: ReturnType<Page["locator"]>, targetBox: { x: number; y: number; width: number; height: number }) {
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error("drag source has no bounding box");

  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Small initial move past dnd-kit's PointerSensor activation distance (8px).
  await page.mouse.move(startX + 15, startY + 15, { steps: 5 });
  await page.mouse.move(endX, endY, { steps: 15 });
  await page.mouse.up();
}

async function createValidatedSolution(page: Page, base: string, title: string) {
  // Deliberately unrelated to `title` (not a substring of it, nor vice
  // versa) — embedding one title inside the other makes getByText(title)
  // ambiguously match the opportunity heading too.
  const oppTitle = `E2E Unsched Opportunity ${Math.random().toString(36).slice(2, 10)}`;

  await page.goto(`${base}/discovery`);
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: /Add opportunity/i }).first().click();
  await page.getByLabel("Title").fill(oppTitle);
  await page.getByRole("button", { name: "Create Opportunity" }).click();
  await expect(page.getByText(oppTitle)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: oppTitle, exact: true }).click();
  await page.getByRole("link", { name: "Open full page" }).click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: oppTitle })).toBeVisible();

  await page.getByRole("button", { name: "Add Solution" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Add Solution" }).last().click();
  await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 });

  // Status changes live in the solution's sidebar panel (the card itself is
  // just a compact summary row) — open it and flip status to Validated.
  await page.getByRole("button", { name: title, exact: true }).click();
  const panel = page.locator('[data-slot="sheet-content"]');
  await expect(panel).toBeVisible();
  await panel.locator('[role="combobox"]').filter({ hasText: "Idea" }).click();
  // A plain click here is deliberate: it regression-tests the Select popup's
  // z-[70] (select.tsx). Before that fix the panel's z-[60] sheet painted over
  // the listbox and swallowed the click.
  await page.getByRole("option", { name: "Validated" }).click();

  // The panel updates its own state in place from the PATCH response — no
  // reload needed, just wait for the label to land.
  await expect(
    panel.locator('[role="combobox"]').filter({ hasText: "Validated" })
  ).toBeVisible({ timeout: 10_000 });
}

test.describe("Roadmap — not yet on the roadmap", () => {
  test(
    "drag a solution onto a horizon, quick-add a bug, drag a second solution onto the timeline",
    async ({ page, base, orgSlug, workspaceSlug }) => {
      const ts = Date.now();
      const solTitle = `E2E Board Solution ${ts}`;
      const sol2Title = `E2E Timeline Solution ${ts}`;
      const bugTitle = `E2E Unsched Bug ${ts}`;

      // ── 1. Create the candidates ────────────────────────────────────────────
      await createValidatedSolution(page, base, solTitle);
      await createValidatedSolution(page, base, sol2Title);

      // Enable the public feedback portal (Settings), same as
      // feedback-bug-roadmap.spec.ts — PortalSettingsPanel renders three
      // toggles in a fixed order (roadmap, feedback, portal-auth-required),
      // so the feedback toggle is always the second switch on the page.
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");
      const feedbackToggle = page.getByRole("switch").nth(1);
      const authToggle = page.getByRole("switch").nth(2);
      if ((await feedbackToggle.getAttribute("aria-checked")) !== "true") {
        await feedbackToggle.click();
        await expect(feedbackToggle).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
      }
      if ((await authToggle.getAttribute("aria-checked")) === "true") {
        await authToggle.click();
        await expect(authToggle).toHaveAttribute("aria-checked", "false", { timeout: 10_000 });
      }

      // Functional specs share one seeded workspace, so make the portal state
      // required by this journey explicit before submitting anonymously.
      await page.goto(`/portal/${orgSlug}/${workspaceSlug}/feedback`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "Bug" }).click();
      await page.getByLabel("Title").fill(bugTitle);
      await page.getByRole("button", { name: "Submit" }).click();
      await expect(page.getByText("Thank you for your feedback!")).toBeVisible({ timeout: 10_000 });

      // ── 2. Roadmap Board: confirm both show up as unscheduled ──────────────
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");

      await expect(page.getByText("Not yet on the roadmap")).toBeVisible({ timeout: 10_000 });
      // Scoped to the panel specifically — dnd-kit's DragOverlay renders a
      // second (briefly-persisting, drop-animating) clone of the dragged
      // card elsewhere in the DOM, which would otherwise make these
      // locators ambiguous right after a drop.
      const unscheduledPanel = page.locator("#unscheduled-items-panel");
      const solutionUnscheduledCard = unscheduledPanel
        .locator('[data-slot="card"]')
        .filter({ hasText: solTitle });
      const bugUnscheduledCard = unscheduledPanel.locator('[data-slot="card"]').filter({ hasText: bugTitle });
      await expect(solutionUnscheduledCard).toBeVisible();
      await expect(bugUnscheduledCard).toBeVisible();

      // ── 3. Drag the solution onto LATER (NOW is decision-gated) ─────────────
      const dragHandle = solutionUnscheduledCard.getByLabel("Drag to schedule");
      const laterColumnBox = await page.locator("#roadmap-column-LATER").boundingBox();
      if (!laterColumnBox) throw new Error("LATER column not found");
      await dragTo(page, dragHandle, laterColumnBox);

      await expect(solutionUnscheduledCard).not.toBeVisible({ timeout: 10_000 });
      const laterColumn = page.locator("#roadmap-column-LATER");
      // .first() — the promoted item's own title AND its "Solution" link
      // chip both show the same solution title, so this text appears twice
      // on the card; either occurrence confirms it landed here.
      await expect(laterColumn.getByText(solTitle).first()).toBeVisible({ timeout: 10_000 });

      // ── 4. Quick-add the bug to NEXT via its card menu (no drag) ────────────
      await bugUnscheduledCard.hover();
      await bugUnscheduledCard.getByLabel("Card actions").click();
      await page.getByRole("menuitem", { name: "Add to Next" }).click();

      await expect(bugUnscheduledCard).not.toBeVisible({ timeout: 10_000 });
      const nextColumn = page.locator("#roadmap-column-NEXT");
      await expect(nextColumn.getByText(bugTitle)).toBeVisible({ timeout: 10_000 });

      // ── 5. Timeline: drag the second solution onto the chart, schedule it ──
      await page.getByRole("tab", { name: "Timeline" }).click();
      await expect(page).toHaveURL(/view=timeline/);
      await page.waitForLoadState("networkidle");

      const sol2UnscheduledCard = unscheduledPanel.locator('[data-slot="card"]').filter({ hasText: sol2Title });
      await expect(sol2UnscheduledCard).toBeVisible({ timeout: 10_000 });

      const dropZoneBox = await page.locator("#gantt-drop-zone").boundingBox();
      if (!dropZoneBox) throw new Error("Gantt drop zone not found");
      await dragTo(page, sol2UnscheduledCard.getByLabel("Drag to schedule"), dropZoneBox);

      const dialog = page.getByRole("dialog");
      const scheduleHeading = dialog.getByRole("heading", { name: "Schedule on the roadmap" });
      // PointerSensor activation can be lost when the browser is busy laying
      // out the newly selected timeline. Retry the same user gesture only if
      // the expected dialog state did not materialize.
      const firstGestureOpenedDialog = await scheduleHeading
        .waitFor({ state: "visible", timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
      if (!firstGestureOpenedDialog) {
        await dragTo(page, sol2UnscheduledCard.getByLabel("Drag to schedule"), dropZoneBox);
      }
      await expect(scheduleHeading).toBeVisible({
        timeout: 10_000,
      });
      // The unscheduled panel still shows the card behind the dialog at this
      // point (it's only removed from state once scheduling succeeds), so
      // scope to the dialog to avoid matching both.
      await expect(dialog.getByText(sol2Title)).toBeVisible();
      // NOW scheduling requires a human decision; this scheduling-specific
      // journey uses NEXT and the dedicated decision-gate spec covers NOW.
      await dialog.getByLabel("Horizon").click();
      await page.getByRole("option", { name: "Next" }).click();
      // Dates are pre-filled with sensible defaults (today -> +14 days); just submit.
      await dialog.getByRole("button", { name: "Schedule" }).click();

      await expect(page.getByRole("heading", { name: "Schedule on the roadmap" })).not.toBeVisible({
        timeout: 10_000,
      });
      await expect(sol2UnscheduledCard).not.toBeVisible({ timeout: 10_000 });
      // The Gantt library renders the task name in both its own grid table
      // and our custom bar template, so scope to .first() to avoid a
      // strict-mode violation — either occurrence confirms it rendered.
      await expect(page.getByText(sol2Title).first()).toBeVisible({ timeout: 10_000 });
    }
  );
});
