/**
 * Workspace Members functional spec.
 *
 * Journey: Settings → add a member by email → change their role to Admin
 *          → remove them.
 *
 * The seeded e2e user is the workspace's only ADMIN, so this spec always
 * adds a second member first rather than mutating the seeded user — the
 * last-admin / last-member guards in removeWorkspaceMember /
 * updateWorkspaceMemberRole would otherwise block every mutation.
 *
 * Uses a timestamped email so parallel runs / retries don't collide.
 */
import { test, expect } from "../fixtures/index";

test.describe("Workspace Members", () => {
  test("add member → change role to Admin → remove member", async ({ page, base }) => {
    const email = `e2e-member-${Date.now()}@example.com`;

    // ── 1. Navigate to Settings ────────────────────────────────────────────
    await page.goto(`${base}/settings`);
    await page.waitForLoadState("networkidle");

    // ── 2. Open the Add Member form ────────────────────────────────────────
    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Email").fill(email);
    // Leave role at its default (Member) for the add step.
    await page.getByRole("button", { name: "Add Member" }).click();

    // Optimistic update appends the row immediately; the form also closes
    // once the server action resolves.
    await expect(page.getByText(email)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("Email")).not.toBeVisible({ timeout: 15_000 });

    // Reload to confirm the membership was actually persisted server-side
    // (not just an optimistic client-only row).
    await page.reload();
    await page.waitForLoadState("load");
    await expect(page.getByText(email)).toBeVisible({ timeout: 10_000 });

    // ── 3. Change the new member's role to Admin ───────────────────────────
    // Scope to this member's row via the (unique, email-derived) remove
    // button's accessible name, then find the role combobox that is its
    // sibling within the same row-controls container.
    const removeButton = page.getByRole("button", { name: `Remove ${email}` });
    const rowControls = removeButton.locator("xpath=..");
    const roleCombobox = rowControls.getByRole("combobox");

    await roleCombobox.click();
    const roleUpdate = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.request().headers()["next-action"] !== undefined &&
        response.ok()
    );
    await page.getByRole("option", { name: "Admin" }).click();
    await roleUpdate;
    await page.reload();
    await page.waitForLoadState("load");

    await expect(
      page.getByRole("button", { name: `Remove ${email}` }).locator("xpath=..").getByRole("combobox")
    ).toContainText(/Admin/i, { timeout: 10_000 });

    // ── 4. Remove the member ────────────────────────────────────────────────
    const removal = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.request().headers()["next-action"] !== undefined &&
        response.ok()
    );
    await page.getByRole("button", { name: `Remove ${email}` }).click();
    await removal;
    await expect(page.getByText(email)).not.toBeVisible({ timeout: 10_000 });

    // Confirm removal persisted server-side too.
    await page.reload();
    await page.waitForLoadState("load");
    await expect(page.getByText(email)).not.toBeVisible({ timeout: 10_000 });
  });
});
