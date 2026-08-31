/**
 * Functional coverage for the shared entity detail panel
 * (components/panels/*): open it from a card, navigate a relation hop, edit a
 * field inline (persisted), deep-link straight to it, and close it with the
 * browser back button.
 *
 * Seeds a Cycle → Objective → Key Result through the OKRs UI, then exercises
 * the panel on the OKRs page. The panel is mounted globally
 * (app/[orgSlug]/[workspaceSlug]/layout.tsx) so this coverage generalizes to
 * every screen; OKRs is just a convenient, low-setup entry point.
 */
import { test, expect } from "../fixtures/index";

test.describe("Entity detail panel", () => {
  test("opens from a card, navigates relations, edits inline, and deep-links", async ({
    page,
    base,
  }) => {
    const ts = Date.now();
    const cycleTitle = `Panel E2E Cycle ${ts}`;
    const objectiveTitle = `Panel E2E Objective ${ts}`;
    const krTitle = `Panel E2E KR ${ts}`;
    const editedTitle = `Panel E2E Objective ${ts} (edited)`;

    // The Discovery board's @dnd-kit SortableContext emits a known, pre-existing
    // hydration-mismatch warning (see canvas.spec.ts) — filter it so this spec
    // still catches new panel errors.
    const KNOWN = ["DndDescribedBy"];
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (KNOWN.some((s) => text.includes(s))) return;
      consoleErrors.push(text);
    });
    page.on("pageerror", (err) => consoleErrors.push(err.message));

    // The panel is a right-side Sheet — target its content by data-slot rather
    // than an ARIA role so the locators don't depend on the overlay library.
    const panel = page.locator('[data-slot="sheet-content"]');

    // ── Seed a Cycle → Objective → Key Result via the OKRs UI ───────────────
    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New Cycle" }).click();
    await page.getByLabel("Title").fill(cycleTitle);
    await page.getByLabel("Start date").fill("2026-07-01");
    await page.getByLabel("End date").fill("2026-09-30");
    await page.getByRole("button", { name: "Create cycle" }).click();
    await expect(page.getByText(cycleTitle)).toBeVisible({ timeout: 60_000 });
    // Let the modal fully release its aria-hidden background before routing;
    // navigating during the close transition carries the temporary attribute
    // into the next page's hydration snapshot.
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10_000 });

    await page.getByText(cycleTitle).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: cycleTitle })).toBeVisible();

    await page.getByRole("button", { name: /Add objective/i }).click();
    await page.getByLabel("Title").fill(objectiveTitle);
    await page.getByRole("button", { name: "Add objective" }).click();
    await expect(page.getByText(objectiveTitle)).toBeVisible({ timeout: 30_000 });

    const objRow = page.locator(".rounded-xl.border").filter({ hasText: objectiveTitle });
    await objRow.getByRole("button", { name: /Add key result/i }).click();
    await objRow.getByLabel("Title").fill(krTitle);
    await objRow.getByLabel("Target").fill("100");
    await objRow.getByLabel("Unit (optional)").fill("%");
    await objRow.getByRole("button", { name: "Add key result" }).click();
    await expect(objRow.getByLabel("Target")).not.toBeVisible({ timeout: 60_000 });

    // ── 1. Open the panel from the Objective title ──────────────────────────
    await objRow.getByRole("button", { name: objectiveTitle }).click();
    // openPanel writes the URL (client push) — assert that, then the render.
    await expect(page).toHaveURL(/detail=objective/, { timeout: 10_000 });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(objectiveTitle);
    await expect(panel).toContainText(krTitle); // its Key Result is listed

    // ── 2. Relation hop: Objective → Key Result ─────────────────────────────
    await panel.getByRole("button").filter({ hasText: krTitle }).click();
    await expect(page).toHaveURL(/detail=keyResult/);
    await expect(panel).toContainText(krTitle);

    // ── 3. Back returns to the Objective panel, then closes it ──────────────
    await page.goBack();
    await expect(page).toHaveURL(/detail=objective/);
    await expect(panel).toContainText(objectiveTitle);
    const deepLinkUrl = page.url(); // objective panel open — reused in step 6

    await page.goBack();
    await expect(page).not.toHaveURL(/[?&]detail=/);
    await expect(panel).toBeHidden();

    // ── 4. Inline-edit the title; it persists ───────────────────────────────
    await objRow.getByRole("button", { name: objectiveTitle }).click();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: objectiveTitle }).click(); // enter edit mode
    const titleInput = panel.getByRole("textbox", { name: "Edit title" });
    await titleInput.fill(editedTitle);
    await titleInput.press("Enter");
    await expect(panel).toContainText(editedTitle, { timeout: 10_000 });

    // Close the modal before navigating. Radix intentionally marks the page
    // background aria-hidden while the sheet is open; forcing a fresh route
    // during that state leaks the temporary attribute into hydration.
    await page.goBack();
    await expect(panel).toBeHidden();

    // Persisted: reload and the edited title shows on the OKRs list.
    await page.goto(`${base}/okrs`);
    await page.getByText(cycleTitle).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(editedTitle)).toBeVisible({ timeout: 15_000 });

    // (Status-dropdown editing is covered by lib/entity-mutations unit tests
    // and the PATCH route; driving the third-party Select here would add
    // brittleness without new coverage — the title round-trip above already
    // exercises the full inline-edit → PATCH → persist path through the UI.)

    // ── 5. Deep-link: loading the panel URL fresh restores the panel ────────
    await page.goto(deepLinkUrl);
    await page.waitForLoadState("networkidle");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel).toContainText(editedTitle);

    expect(consoleErrors).toEqual([]);
  });
});
