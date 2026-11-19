/**
 * Roadmap Item shared Conversations functional spec (was the shared Discussion spec; #593 replaced Discussion).
 *
 * Exercises the roadmap item conversation lifecycle through the panels: start a thread from the item's Conversations section, follow
 * up, edit a message, resolve and reopen, persist across a reopen, and archive then restore. There is no per-message delete: a
 * thread leaves the list by being archived, which is reversible.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

const conversationPanel = (page: Page) =>
  page
    .locator('[data-slot="pinned-panel"]')
    .filter({ has: page.getByRole("heading", { name: "Conversation", exact: true }) })
    .or(page.getByRole("dialog", { name: "Conversation", exact: true }))

test.describe("Roadmap Item shared Conversations", () => {
  test("start, follow up, edit, resolve, reopen, persist, and archive then restore a thread", async ({ page, base }) => {
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

    const itemPanel = page.locator('[data-slot="sheet-content"]');
    const section = () => itemPanel.getByTestId("object-conversations-section");
    await expect(section().getByText(/No conversations on this item yet/)).toBeVisible({ timeout: 10_000 });

    // Start the thread; Send opens it in the Conversation panel, replacing the item panel.
    await section().getByTestId("object-conversation-composer").fill(rootBody);
    await section().getByRole("button", { name: "Send", exact: true }).click();
    const thread = conversationPanel(page);
    await expect(thread.getByText(rootBody, { exact: true })).toBeVisible({ timeout: 10_000 });

    await thread.getByPlaceholder(/message the agent/i).fill(replyBody);
    await thread.getByRole("button", { name: "Send message" }).click();
    await expect(thread.getByText(replyBody, { exact: true })).toBeVisible({ timeout: 10_000 });

    const rootMessage = thread.getByTestId("conversation-message").filter({ hasText: rootBody });
    const editRoot = rootMessage.getByRole("button", { name: /Edit comment by / });
    await expect(editRoot).toBeEnabled();
    await editRoot.click();
    await thread.getByRole("textbox", { name: /Edit comment by / }).fill(editedRootBody);
    await thread.getByRole("button", { name: "Save edit" }).click();
    await expect(thread.getByText(editedRootBody, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(thread.getByText("Edited", { exact: true })).toBeVisible();

    await thread.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(thread.getByText("Resolved", { exact: true })).toBeVisible({ timeout: 10_000 });
    await thread.getByRole("button", { name: "Reopen", exact: true }).click();
    await expect(thread.getByRole("button", { name: "Resolve", exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(thread.getByText(replyBody, { exact: true })).toBeVisible();

    // Persist: close, reopen the item, open the thread from its Conversations section.
    await page.getByRole("button", { name: "Close panel" }).click();
    await expect(thread).not.toBeVisible();
    await card.getByRole("button", { name: itemTitle }).click();
    await section().getByRole("button", { name: new RegExp(`^${rootBody}`) }).click();
    await expect(thread.getByText(editedRootBody, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(thread.getByText(replyBody, { exact: true })).toBeVisible();

    // Archive (reversible) instead of delete: the thread leaves the active list and returns on restore.
    await thread.getByRole("button", { name: "Archive conversation" }).click();
    await page.getByRole("alertdialog", { name: "Archive this conversation?" }).getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Close panel" }).click();
    await card.getByRole("button", { name: itemTitle }).click();
    await expect(section().getByRole("button", { name: /^Show archived/ })).toBeVisible({ timeout: 10_000 });
    await expect(section().getByRole("button", { name: new RegExp(`^${rootBody}`) })).toHaveCount(0);
    await section().getByRole("button", { name: /^Show archived/ }).click();
    const archivedRow = section().getByRole("listitem").filter({ hasText: rootBody });
    await expect(archivedRow).toBeVisible({ timeout: 10_000 });
    await archivedRow.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(section().getByRole("status")).toContainText("Conversation restored.");
    await section().getByRole("button", { name: /^Show archived/ }).click();
    await expect(section().getByRole("button", { name: new RegExp(`^${rootBody}`) })).toBeVisible({ timeout: 10_000 });
  });
});
