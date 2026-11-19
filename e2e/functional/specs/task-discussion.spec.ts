import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

const conversationPanel = (page: Page) =>
  page
    .locator('[data-slot="pinned-panel"]')
    .filter({ has: page.getByRole("heading", { name: "Conversation", exact: true }) })
    .or(page.getByRole("dialog", { name: "Conversation", exact: true }))

test.describe("Task shared Conversations", () => {
  test("shows API history and persists conversations, follow-ups, edits, resolution and archive", async ({ page, base }, testInfo) => {
    await page.goto(`${base}/tasks`);
    const todo = page.locator('[data-task-column="TODO"]');
    await todo.getByRole("button", { name: /Add task/i }).click();
    const title = "Review the onboarding handoff";
    await page.getByLabel("Title").fill(title);
    await todo.getByRole("button", { name: "Add Task", exact: true }).click();
    // The card title opens the shared slide-over panel (same TaskDetail, Conversations included); "Open full page" is the hop to
    // the /tasks/<id> route the rest of this spec reloads against.
    const panel = page.locator('[data-slot="sheet-content"]');
    await todo.getByRole("button", { name: title }).click();
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId("object-conversations-section").getByText(/No conversations on this item yet/)).toBeVisible({ timeout: 15_000 });
    await panel.getByRole("link", { name: "Open full page" }).click();
    await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
    const targetId = new URL(page.url()).pathname.split("/").at(-1)!;
    const section = page.getByTestId("object-conversations-section");
    await expect(section.getByText(/No conversations on this item yet/)).toBeVisible();
    const thread = conversationPanel(page);
    async function expectHistoricalComment() {
      await expect(thread.locator("li").filter({ hasText: "Confirm scope" })).toBeVisible();
      await expect(thread.getByRole("checkbox")).toBeChecked();
      await expect(thread.locator("del")).toHaveText("Old estimate");
      await expect(thread.locator("code")).toHaveText("handoff");
      await expect(thread.getByRole("link", { name: "notes" })).toHaveAttribute("href", "https://example.com/notes");
      await expect(thread.getByText("Ready for review.", { exact: true })).toBeVisible();
    }

    // Existing API history (a comment made through the API) must appear on the same task as a conversation with source text intact.
    const history = "- [x] Confirm scope\n~~Old estimate~~ `handoff` [notes](https://example.com/notes)\n\nReady for review.";
    const created = await page.request.post("/api/comments", { data: { targetType: "TASK", targetId, body: history } });
    expect(created.ok()).toBe(true);
    const historicalComment = await created.json();
    await page.reload();
    const historyRow = section.getByRole("button", { name: /Confirm scope/ });
    await expect(historyRow).toBeVisible({ timeout: 15_000 });
    await historyRow.click();
    await expectHistoricalComment();
    const stored = await page.request.get(`/api/comments?targetType=TASK&targetId=${targetId}`);
    expect(stored.ok()).toBe(true);
    expect((await stored.json()).items.find((item: { id: string }) => item.id === historicalComment.id).body).toBe(history);

    await section.getByTestId("object-conversation-composer").fill("The support checklist is ready.");
    await section.getByRole("button", { name: "Send", exact: true }).click();
    await expect(thread.getByText("The support checklist is ready.", { exact: true })).toBeVisible({ timeout: 15_000 });
    const root = thread.getByTestId("conversation-message").filter({ hasText: "The support checklist is ready" });
    await root.getByRole("button", { name: /Edit comment by/ }).click();
    await thread.getByRole("textbox", { name: /Edit comment by/ }).fill("The support checklist is ready for review.");
    await thread.getByRole("button", { name: "Save edit" }).click();
    await expect(thread.getByText("Edited", { exact: true })).toBeVisible();
    await thread.getByPlaceholder(/message the agent/i).fill("Reviewed. Ready for the next step.");
    await thread.getByRole("button", { name: "Send message" }).click();
    await expect(thread.getByText("Reviewed. Ready for the next step.")).toBeVisible();

    // The detail's other sections and the Conversations are stacked on one surface, so assert they coexist.
    await page.getByRole("button", { name: "More properties", exact: true }).click();
    await expect(page.getByText("Story points")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add link" })).toBeVisible();
    await expect(section).toBeVisible();
    await page.reload();
    await expect(thread.getByText("The support checklist is ready for review.")).toBeVisible();
    await expect(thread.getByText("Reviewed. Ready for the next step.")).toBeVisible();

    // Close the panel so the section composer is measured on its own at each width.
    await page.getByRole("button", { name: "Close panel" }).click();
    for (const [name, viewport] of [
      ["desktop", { width: 1280, height: 800 }],
      ["mobile", { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(viewport);
      // The title is an inline-editable control now, not a heading.
      await page.getByRole("button", { name: title }).scrollIntoViewIfNeeded();
      await expect(section.getByTestId("object-conversation-composer")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`task-discussion-${name}.png`), fullPage: true });
      // Scroll the workspace container to include its bottom-nav safe padding.
      await page.getByRole("main").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      // Send is disabled while the composer is empty, and a trial click needs an enabled target: type a draft so this still proves
      // the button is reachable (not covered by the bottom nav), then clear it.
      const composer = section.getByTestId("object-conversation-composer");
      await composer.fill("Layout check, not posted");
      await section.getByRole("button", { name: "Send", exact: true }).click({ trial: true });
      await page.screenshot({ path: testInfo.outputPath(`task-discussion-composer-${name}.png`), fullPage: true });
      await composer.fill("");
    }

    await section.getByRole("button", { name: /^The support checklist is ready/ }).click();
    await thread.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(thread.getByText("Resolved", { exact: true })).toBeVisible();
    await thread.getByRole("button", { name: "Reopen", exact: true }).click();
    await expect(thread.getByText("Reviewed. Ready for the next step.")).toBeVisible();

    // No per-message delete: a thread leaves the list by being archived, and returns on restore. The API history thread is untouched.
    await thread.getByRole("button", { name: "Archive conversation" }).click();
    await page.getByRole("alertdialog", { name: "Archive this conversation?" }).getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Close panel" }).click();
    await page.reload();
    await expect(section.getByRole("button", { name: /Confirm scope/ })).toBeVisible({ timeout: 15_000 });
    await expect(section.getByRole("button", { name: /^The support checklist is ready/ })).toHaveCount(0);
    await section.getByRole("button", { name: /^Show archived/ }).click();
    const archivedRow = section.getByRole("listitem").filter({ hasText: "The support checklist is ready" });
    await expect(archivedRow).toBeVisible({ timeout: 10_000 });
    await archivedRow.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(section.getByRole("status")).toContainText("Conversation restored.");
    await section.getByRole("button", { name: /^Show archived/ }).click();
    await expect(section.getByRole("button", { name: /^The support checklist is ready/ })).toBeVisible({ timeout: 10_000 });
  });
});
