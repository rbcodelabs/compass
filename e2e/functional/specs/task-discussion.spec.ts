import { test, expect } from "../fixtures/index";

test.describe("Task shared Discussion", () => {
  test("shows API history and persists comments, replies, edits and resolution", async ({ page, base }, testInfo) => {
    await page.goto(`${base}/tasks`);
    const todo = page.locator('[data-task-column="TODO"]');
    await todo.getByRole("button", { name: /Add task/i }).click();
    const title = "Review the onboarding handoff";
    await page.getByLabel("Title").fill(title);
    await todo.getByRole("button", { name: "Add Task", exact: true }).click();
    await todo.getByRole("link", { name: title }).click();
    await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
    const targetId = new URL(page.url()).pathname.split("/").at(-1)!;
    const discussion = page.getByRole("region", { name: "Discussion" });
    await expect(discussion.getByText("No comments yet.")).toBeVisible();

    // Existing API history must appear on the same task with source text intact.
    const history = "- [x] Confirm scope\n~~Old estimate~~ `handoff` [notes](https://example.com/notes)\n\nReady for review.";
    const created = await page.request.post("/api/comments", { data: { targetType: "TASK", targetId, body: history } });
    expect(created.ok()).toBe(true);
    const historicalComment = await created.json();
    await page.reload();
    await expect(discussion.getByText(history)).toBeVisible();
    const stored = await page.request.get(`/api/comments?targetType=TASK&targetId=${targetId}`);
    expect(stored.ok()).toBe(true);
    expect((await stored.json()).items.find((item: { id: string }) => item.id === historicalComment.id).body).toBe(history);

    await discussion.getByLabel("Add comment").fill("The support checklist is ready.");
    await discussion.getByRole("button", { name: "Post comment" }).click();
    await expect(discussion.getByText("The support checklist is ready.")).toBeVisible();
    const root = discussion.locator("article").filter({ hasText: "The support checklist is ready" });
    await root.getByRole("button", { name: /Edit comment by/ }).click();
    await discussion.getByRole("textbox", { name: /Edit comment by/ }).fill("The support checklist is ready for review.");
    await discussion.getByRole("button", { name: "Save edit" }).click();
    await expect(discussion.getByText("Edited", { exact: true })).toBeVisible();
    await root.getByRole("button", { name: /Reply to/ }).click();
    await discussion.getByRole("textbox", { name: /Reply to/ }).fill("Reviewed. Ready for the next step.");
    await discussion.getByRole("button", { name: "Post reply" }).click();
    await expect(discussion.getByText("Reviewed. Ready for the next step.")).toBeVisible();

    await page.getByRole("tab", { name: /Links/ }).click();
    await expect(discussion).toBeVisible();
    await page.getByRole("tab", { name: "Overview" }).click();
    await page.reload();
    await expect(discussion.getByText("The support checklist is ready for review.")).toBeVisible();
    await expect(discussion.getByText("Reviewed. Ready for the next step.")).toBeVisible();

    for (const [name, viewport] of [
      ["desktop", { width: 1280, height: 800 }],
      ["mobile", { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await page.getByRole("heading", { name: title }).scrollIntoViewIfNeeded();
      await expect(discussion.getByLabel("Add comment")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`task-discussion-${name}.png`), fullPage: true });
      // Scroll the workspace container to include its bottom-nav safe padding.
      await page.getByRole("main").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await discussion.getByRole("button", { name: "Post comment" }).click({ trial: true });
      await page.screenshot({ path: testInfo.outputPath(`task-discussion-composer-${name}.png`), fullPage: true });
    }

    await root.getByRole("button", { name: /Resolve thread by/ }).click();
    await expect(discussion.getByRole("button", { name: /Expand resolved thread by/ })).toBeVisible();
    await discussion.getByRole("button", { name: /Reopen thread by/ }).click();
    await expect(discussion.getByText("Reviewed. Ready for the next step.")).toBeVisible();
    await root.getByRole("button", { name: /Delete comment by/ }).click();
    await expect(discussion.getByText("Reviewed. Ready for the next step.")).not.toBeVisible();
    await page.reload();
    await root.getByRole("button", { name: /Delete comment by/ }).click();
    await expect(discussion.getByText("The support checklist is ready for review.")).not.toBeVisible();
    await page.reload();
    await expect(discussion.getByText(history)).toBeVisible();
    await expect(discussion.getByText("The support checklist is ready for review.")).not.toBeVisible();
  });
});
