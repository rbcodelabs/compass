/**
 * OKRs functional spec.
 *
 * Journey: Create cycle → navigate in → add objective → add key result
 *          → log check-in → change objective status.
 *
 * Each test run uses a unique title (via timestamp) so parallel runs or
 * retries don't collide with each other.
 */
import { test, expect } from "../fixtures/index";

test.describe("OKRs", () => {
  test("create cycle → objective → KR → check-in → status change", async ({
    page,
    base,
  }) => {
    const ts = Date.now();
    const cycleTitle = `E2E Cycle ${ts}`;
    const objectiveTitle = `E2E Objective ${ts}`;
    const krTitle = `E2E KR ${ts}`;

    // ── 1. Navigate to OKRs ──────────────────────────────────────────────────
    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");

    // ── 2. Create a new cycle ────────────────────────────────────────────────
    await page.getByRole("button", { name: "New Cycle" }).click();
    await page.getByLabel("Title").fill(cycleTitle);
    await page.getByLabel("Start date").fill("2026-07-01");
    await page.getByLabel("End date").fill("2026-09-30");
    await page.getByRole("button", { name: "Create cycle" }).click();

    // Cycle card visible on the list page
    await expect(page.getByText(cycleTitle)).toBeVisible({ timeout: 15_000 });

    // ── 3. Open the cycle ────────────────────────────────────────────────────
    await page.getByText(cycleTitle).click();
    await page.waitForLoadState("networkidle");
    // Confirm we're on the cycle detail page
    await expect(page.getByRole("heading", { name: cycleTitle })).toBeVisible();

    // ── 4. Add an objective ──────────────────────────────────────────────────
    await page.getByRole("button", { name: /Add objective/i }).click();
    await page.getByLabel("Title").fill(objectiveTitle);
    await page.getByRole("button", { name: "Add objective" }).click();

    // Objective title appears in the list
    await expect(page.getByText(objectiveTitle)).toBeVisible({ timeout: 10_000 });

    // ── 5. Add a key result ──────────────────────────────────────────────────
    await page.getByRole("button", { name: /Add key result/i }).click();
    await page.getByLabel("Title").fill(krTitle);
    await page.getByLabel("Target").fill("100");
    await page.getByLabel("Unit (optional)").fill("%");
    await page.getByRole("button", { name: "Add key result" }).click();

    // The form closes once the server action completes (setOpen(false) is called
    // inside startTransition after `await addKeyResult(...)`). The "Target"
    // label is unique to the AddKeyResultForm; its disappearance means the
    // action is done and the DB has been updated.
    await expect(page.getByLabel("Target")).not.toBeVisible({ timeout: 20_000 });

    // Force a hard reload to get fresh server-rendered data with the new KR.
    // Next.js dev-mode router auto-refresh from revalidatePath can be slow;
    // a reload is the reliable fallback.
    await page.reload();
    await page.waitForLoadState("load");

    // KR title appears in the row
    await expect(page.getByText(krTitle)).toBeVisible({ timeout: 10_000 });

    // ── 6. Log a check-in ───────────────────────────────────────────────────
    // KR bar shows initial progress "0 % / 100 %"
    await expect(page.getByText("0 % / 100 %")).toBeVisible();

    await page.getByRole("button", { name: "Check in" }).click();
    // Clear current value (pre-filled with 0) and enter 50
    await page.getByLabel("Current value").fill("50");
    await page.getByRole("button", { name: "Save check-in" }).click();

    // Wait for the check-in form to close (server action done → setOpen(false)).
    // "Current value" label is unique to CheckInForm.
    await expect(page.getByLabel("Current value")).not.toBeVisible({ timeout: 15_000 });
    // Reload to get fresh server data with updated KR progress.
    await page.reload();
    await page.waitForLoadState("load");

    // After check-in, KR bar reflects new value
    await expect(page.getByText("50 % / 100 %")).toBeVisible({ timeout: 10_000 });
    // "50%" appears both in the KR progress bubble and the objective avg — use
    // .first() to avoid strict-mode violation.
    await expect(page.getByText("50%").first()).toBeVisible();

    // ── 7. Change objective status to AT_RISK ───────────────────────────────
    // The objective-row status Select is the FIRST combobox in the objective
    // card (parent-KR picker is second).  After a page reload with
    // waitForLoadState("load"), React may still be hydrating which means
    // SelectValue might not have connected to SelectItems yet — the combobox
    // accessible name fluctuates between "ON_TRACK" (raw value) and "On track"
    // (rendered label).  Use nth(0) to get the status combobox regardless of
    // which text it currently shows, and wait for it to be clickable.
    const statusCombobox = page.locator('[role="combobox"]').nth(0);
    await expect(statusCombobox).toBeEnabled({ timeout: 10_000 });
    await statusCombobox.click();
    await page.getByRole("option", { name: "At risk" }).click();

    // The updateObjectiveStatus action is a fast DB update.  Allow 2 s for
    // the server action to complete before forcing a reload.
    await page.waitForTimeout(2_000);
    await page.reload();
    await page.waitForLoadState("load");

    // After reload, the objective status combobox reflects the new status.
    // ObjectiveRow uses Radix <SelectValue /> which in SSR/pre-hydration
    // renders the raw enum value ("AT_RISK") rather than the label ("At risk")
    // because SelectItems haven't connected to context yet.  Match either form.
    await expect(
      page.locator('[role="combobox"]').nth(0)
    ).toContainText(/AT_RISK|At risk/, { timeout: 10_000 });
  });
});
