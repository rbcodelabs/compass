/**
 * Roadmap "Not scheduled" functional spec.
 *
 * Journey:
 *   1. Create a validated Solution via Discovery and a Bug via the public
 *      portal — neither is on the roadmap yet.
 *   2. On the roadmap Board, confirm both appear in the final "Not scheduled"
 *      Kanban column after Shipped.
 *   3. Drag the Solution card onto the LATER column — confirm it lands there
 *      and disappears from the unscheduled panel.
 *   4. Use the Bug card's quick-add menu (no drag) to add it to NEXT —
 *      confirm it lands there too.
 *   5. Create a second Solution, switch to Timeline view, confirm it's
 *      listed as unscheduled there too, then drop it directly onto a native
 *      timeline lane and confirm scheduling persists after reload.
 *
 * dnd-kit's PointerSensor needs real mouse movement (not a single jump) to
 * activate past its 8px activation-distance threshold, so drags here are
 * simulated with page.mouse.move/down/up rather than Playwright's built-in
 * dragTo (which doesn't reliably trigger pointer-sensor-based DnD).
 */
import { test, expect } from "../fixtures/index";
import { openFullPage } from "../fixtures/full-page";
import type { Locator, Page } from "@playwright/test";

async function dragTo(page: Page, source: Locator, target: Locator, scrollContainer?: Locator) {
  await source.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error("drag source has no bounding box");

  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Small initial move past dnd-kit's PointerSensor activation distance (8px).
  await page.mouse.move(startX + 15, startY + 15, { steps: 10 });

  // The source and destination can live in distant columns of the horizontally
  // scrolling board. Hold the pointer at the board edge so dnd-kit's normal
  // auto-scroll updates its collision geometry as the destination comes into
  // view; an instant scroll jump leaves dnd-kit aiming at stale column rects.
  if (scrollContainer) {
    const scrollBox = await scrollContainer.boundingBox();
    if (!scrollBox) throw new Error("drag scroll container has no bounding box");

    const edgeY = Math.min(Math.max(startY, scrollBox.y + 16), scrollBox.y + scrollBox.height - 16);
    await expect
      .poll(
        async () => {
          const box = await target.boundingBox();
          if (!box) return false;
          if (box.x >= scrollBox.x && box.x + box.width <= scrollBox.x + scrollBox.width) return true;

          const edgeX = box.x < scrollBox.x ? scrollBox.x + 8 : scrollBox.x + scrollBox.width - 8;
          await page.mouse.move(edgeX, edgeY, { steps: 5 });
          return false;
        },
        { timeout: 10_000 }
      )
      .toBe(true);
  }

  const targetBox = await target.boundingBox();
  if (!targetBox) throw new Error("drag target has no bounding box");
  // Native lanes span the logical canvas, wider than the visible scroll
  // region. Drop in the visible part rather than outside the browser.
  const endX = Math.min(targetBox.x + targetBox.width / 2, (page.viewportSize()?.width ?? 1280) - 32);
  const endY = targetBox.y + targetBox.height / 2;

  await page.mouse.move(endX, endY, { steps: 40 });
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
  // The outgoing panel has the same heading and controls. Its already-idle
  // document does not prove the client-side navigation has committed.
  await openFullPage(page);
  const detail = page.locator('[data-slot="opportunity-detail"][data-variant="page"]');
  await expect(detail.getByRole("heading", { name: oppTitle })).toBeVisible();

  await detail.getByRole("button", { name: "Add Solution" }).click();
  await detail.getByLabel("Title").fill(title);
  await detail.getByRole("button", { name: "Add Solution" }).click();
  await expect(detail.getByText(title)).toBeVisible({ timeout: 10_000 });

  // Status changes live in the solution's sidebar panel (the card itself is
  // just a compact summary row) — open it and flip status to Validated.
  await detail.getByRole("button", { name: title, exact: true }).click();
  const panel = page.locator('[data-slot="sheet-content"]');
  await expect(panel).toBeVisible();
  await panel.locator('[role="combobox"]').filter({ hasText: "Idea" }).click();
  // A plain click here is deliberate: it regression-tests the Select popup's
  // popup layer (select.tsx). Before that fix the panel layer's sheet painted
  // over the listbox and swallowed the click.
  await page.getByRole("option", { name: "Validated" }).click();

  // The panel updates its own state in place from the PATCH response — no
  // reload needed, just wait for the label to land.
  await expect(
    panel.locator('[role="combobox"]').filter({ hasText: "Validated" })
  ).toBeVisible({ timeout: 10_000 });
}

test.describe("Roadmap — not yet on the roadmap", () => {
  test("creates a validated candidate after delayed full-page navigation", async ({ page, base }) => {
    const editedVariants: Array<string | null> = [];
    await page.exposeFunction("recordSolutionEdit", (variant: string | null) => editedVariants.push(variant));
    await page.addInitScript(() => {
      document.addEventListener("input", (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.placeholder !== "Solution title") return;
        const detail = input.closest('[data-slot="opportunity-detail"]');
        void (window as typeof window & { recordSolutionEdit: (variant: string | null) => Promise<void> })
          .recordSolutionEdit(detail?.getAttribute("data-variant") ?? null);
      });
    });
    // The panel and full page share a heading and Add Solution controls. Keep
    // the outgoing panel visible while the destination response is in flight.
    await page.route(`**${base}/discovery/*`, async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.fulfill({ response });
    });
    await createValidatedSolution(page, base, `E2E Delayed Solution ${Date.now()}`);
    try {
      expect(editedVariants).toEqual(["page"]);
    } finally {
      // This suite shares a workspace. Do not leave an extra eligible candidate
      // in the next test's otherwise-empty unscheduled roadmap column.
      const panel = page.locator('[data-slot="sheet-content"]');
      await panel.locator('[role="combobox"]').filter({ hasText: "Validated" }).click();
      await page.getByRole("option", { name: "Idea", exact: true }).click();
      await expect(panel.locator('[role="combobox"]').filter({ hasText: "Idea" })).toBeVisible();
    }
  });

  test(
    "preserves board drag and persists direct timeline placement",
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
      // By test id, not position: the auth-required switch only renders once
      // the portal is public, so `switch.nth(2)` could resolve to a different
      // switch (and read "unchecked") before it appeared, leaving the portal
      // requiring sign-in and the anonymous Submit below disabled.
      const feedbackToggle = page.getByTestId("portal-toggle-feedback");
      const authToggle = page.getByTestId("portal-toggle-auth-required");
      if ((await feedbackToggle.getAttribute("aria-checked")) !== "true") {
        await feedbackToggle.click();
        await expect(feedbackToggle).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
      }
      await expect(authToggle).toBeVisible();
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

      await expect(page.getByRole("heading", { name: "Not scheduled" })).toBeVisible({ timeout: 10_000 });
      const boardColumns = page.locator('[data-slot="roadmap-board-track"] > *');
      await expect(boardColumns.last()).toHaveAttribute("data-testid", "roadmap-unscheduled-column");
      // Scoped to the panel specifically — dnd-kit's DragOverlay renders a
      // second (briefly-persisting, drop-animating) clone of the dragged
      // card elsewhere in the DOM, which would otherwise make these
      // locators ambiguous right after a drop.
      const unscheduledPanel = page.getByTestId("roadmap-unscheduled-column");
      const solutionUnscheduledCard = unscheduledPanel
        .locator('[data-slot="card"]')
        .filter({ hasText: solTitle });
      const bugUnscheduledCard = unscheduledPanel.locator('[data-slot="card"]').filter({ hasText: bugTitle });
      await expect(solutionUnscheduledCard).toBeVisible();
      await expect(bugUnscheduledCard).toBeVisible();

      // ── 3. Drag the solution onto LATER ──────────────────────────────────
      const dragHandle = solutionUnscheduledCard.getByLabel("Drag to schedule");
      const laterColumn = page.locator("#roadmap-column-LATER");
      const roadmapBoard = page.getByRole("region", { name: "Roadmap board" });
      await dragTo(page, dragHandle, laterColumn, roadmapBoard);

      await expect(solutionUnscheduledCard).not.toBeVisible({ timeout: 10_000 });
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

      // ── 5. Timeline: drop the second solution and submit its schedule ──────
      await page.setViewportSize({ width: 1440, height: 1600 });
      await page.getByRole("tab", { name: "Timeline" }).click();
      await expect(page).toHaveURL(/view=timeline/);
      await page.waitForLoadState("networkidle");

      const timelineUnscheduledPanel = page.locator("#unscheduled-items-panel");
      const sol2UnscheduledCard = timelineUnscheduledPanel
        .locator('[data-slot="card"]')
        .filter({ hasText: sol2Title });
      await expect(sol2UnscheduledCard).toBeVisible({ timeout: 10_000 });

      const dropZone = page.getByTestId("timeline-drop-lane:NEXT:unassigned");
      await dragTo(page, sol2UnscheduledCard.getByLabel("Drag to schedule"), dropZone);

      // Wait for acknowledged removal, not merely an offscreen drag source,
      // before reloading the route and verifying persistence.
      await expect(sol2UnscheduledCard).toHaveCount(0, { timeout: 10_000 });
      await Promise.all([
        page.waitForEvent("load"),
        page.getByRole("button", { name: "Reload timeline" }).click(),
      ]);
      const persistedBar = page.locator('[data-testid^="timeline-item-"][data-start]').filter({ hasText: sol2Title });
      await expect(persistedBar).toHaveAttribute("data-start", /^\d{4}-\d{2}-\d{2}$/);
      await expect(persistedBar).toHaveAttribute("data-end", /^\d{4}-\d{2}-\d{2}$/);
      await expect(sol2UnscheduledCard).toHaveCount(0);
      await page.getByRole("tab", { name: "Board" }).click();
      await expect(page.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
      const scheduledCard = page.locator('[data-slot="card"]').filter({ hasText: sol2Title });
      await expect(scheduledCard.getByText(sol2Title).first()).toBeVisible({ timeout: 10_000 });
      // All three of this journey's candidates have left the unscheduled
      // column. Don't assert the column is *empty*: the functional specs share
      // one seeded workspace, and earlier journeys (e.g. discovery swimlanes,
      // pinned selects) legitimately leave their own validated solutions
      // unscheduled. The empty state itself is covered by
      // __tests__/components/unscheduled-items-column.test.tsx.
      const boardUnscheduled = page.getByTestId("roadmap-unscheduled-column");
      await expect(boardUnscheduled).toBeVisible();
      for (const title of [solTitle, sol2Title, bugTitle]) {
        await expect(boardUnscheduled.locator('[data-slot="card"]').filter({ hasText: title })).toHaveCount(0);
      }
    }
  );
});
