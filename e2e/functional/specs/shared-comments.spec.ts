/**
 * Shared Discussion functional spec.
 *
 * Exercises the complete Roadmap Item discussion lifecycle through the panel,
 * including persistence and the deliberate destructive confirmation required
 * when an administrator deletes a root that still has replies.
 */
import { test, expect } from "../fixtures/index";

test.describe("Roadmap Item shared Discussion", () => {
  test("add, reply, edit, resolve, reopen, persist, and safely delete a thread", async ({ page, base }) => {
    const stamp = Date.now();
    const itemTitle = `E2E Shared Discussion ${stamp}`;
    const rootBody = `Root comment ${stamp}`;
    const editedRootBody = `Edited root comment ${stamp}`;
    const replyBody = `Reply ${stamp}`;

    await page.goto(`${base}/roadmap`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Add item" }).nth(1).click();
    await page.getByLabel("Title").fill(itemTitle);
    await page.getByRole("button", { name: "Add Item", exact: true }).click();

    const card = page.locator('[data-slot="card"]').filter({ hasText: itemTitle });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole("button", { name: itemTitle }).click();

    let panel = page.locator('[data-slot="sheet-content"]');
    const discussion = panel.getByRole("heading", { name: "Discussion" }).locator("..");
    await expect(panel.getByText("No comments yet.")).toBeVisible({ timeout: 10_000 });

    await panel.getByLabel("Add comment").fill(rootBody);
    await panel.getByRole("button", { name: "Post comment" }).click();
    await expect(panel.getByText(rootBody)).toBeVisible({ timeout: 10_000 });

    await panel.getByRole("button", { name: /Reply to / }).click();
    await panel.getByRole("textbox", { name: /Reply to / }).fill(replyBody);
    await panel.getByRole("button", { name: "Post reply" }).click();
    await expect(panel.getByText(replyBody)).toBeVisible({ timeout: 10_000 });

    const editRoot = panel.getByRole("button", { name: /Edit comment by / }).first();
    await expect(editRoot).toBeEnabled();
    await editRoot.click();
    await panel.getByRole("textbox", { name: /Edit comment by / }).fill(editedRootBody);
    await panel.getByRole("button", { name: "Save edit" }).click();
    await expect(panel.getByText(editedRootBody)).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText("Edited", { exact: true })).toBeVisible();

    await panel.getByRole("button", { name: /Resolve thread by / }).click();
    await expect(panel.getByRole("button", { name: /Expand resolved thread by / })).toBeVisible({ timeout: 10_000 });
    await panel.getByRole("button", { name: /Reopen thread by / }).click();
    await expect(panel.getByText(replyBody)).toBeVisible({ timeout: 10_000 });

    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).not.toBeVisible();
    await card.getByRole("button", { name: itemTitle }).click();
    panel = page.locator('[data-slot="sheet-content"]');
    await expect(panel.getByText(editedRootBody)).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText(replyBody)).toBeVisible();

    let confirmations = 0;
    page.on("dialog", async (dialog) => {
      confirmations += 1;
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain("every reply");
      await dialog.accept();
    });
    await panel.getByRole("button", { name: /Delete thread by / }).click();
    await expect(panel.getByText(editedRootBody)).not.toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText(replyBody)).not.toBeVisible();
    expect(confirmations).toBe(1);
    await expect(panel.getByText("No comments yet.")).toBeVisible();
    await expect(discussion).toBeAttached();
  });
});
