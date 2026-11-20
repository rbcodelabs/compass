import pg from "pg"
import { test, expect } from "../fixtures/index"
import { isolatedE2EConnectionString } from "../fixtures/isolated-database"
import { E2E_ORG_SLUG, E2E_WORKSPACE_SLUG } from "../fixtures/seed-e2e"

// #593 replaced roadmap-item "Discussion" comments with Conversations. A person's own turns do not show their name in the
// transcript, so "the rename reaches past and future comments" is asserted where the author name is served: the conversation's
// messages API (live name lookup by authorUserId), which is what the transcript renders from.
type Message = { content: string; role: string; authorName: string | null; editedAt?: unknown }

test("Profile updates past and future conversation author names and account navigation", async ({ page, base }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto("/settings/profile")
  const originalName = await page.getByLabel("Display name").inputValue()
  const desiredName = originalName === "Alex Taylor" ? "Jordan Taylor" : "Alex Taylor"
  await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute("readonly", "")
  const title = `Profile discussion ${Date.now()}`
  let failed = false
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() })
  const conversationPanel = () =>
    page
      .locator('[data-slot="pinned-panel"]')
      .filter({ has: page.getByRole("heading", { name: "Conversation", exact: true }) })
      .or(page.getByRole("dialog", { name: "Conversation", exact: true }))
  const openedConversationId = () => {
    const detail = new URL(page.url()).searchParams.get("detail") ?? ""
    return detail.startsWith("conversation:") ? detail.slice("conversation:".length) : ""
  }
  const messages = async (workspaceId: string, conversationId: string) => {
    const response = await page.request.get(`/api/agent/conversations/${conversationId}/messages?workspaceId=${workspaceId}`)
    expect(response.status()).toBe(200)
    return ((await response.json()) as { messages: Message[] }).messages
  }
  try {
    const { rows: [scope] } = await pool.query<{ id: string }>(
      "SELECT w.id FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON o.id=w.organization_id WHERE o.slug=$1 AND w.slug=$2",
      [E2E_ORG_SLUG, E2E_WORKSPACE_SLUG],
    )
    const workspaceId = scope.id
    await page.goto(`${base}/roadmap`)
    await page.getByRole("button", { name: "Add item" }).nth(1).click()
    await page.getByLabel("Title", { exact: true }).fill(title)
    await page.getByRole("button", { name: "Add Item", exact: true }).click()
    const card = page.locator('[data-slot="card"]').filter({ hasText: title })
    await card.getByRole("button", { name: title }).click()
    const itemPanel = page.locator('[data-slot="sheet-content"]')
    const itemConversations = itemPanel.getByTestId("object-conversations-section")
    await itemConversations.getByTestId("object-conversation-composer").fill("A comment before the rename")
    await itemConversations.getByRole("button", { name: "Send", exact: true }).click()
    // Send opens the new conversation in the Conversation panel, where the follow-up is the old "reply".
    await expect(conversationPanel().getByTestId("conversation-message").getByText("A comment before the rename", { exact: true })).toBeVisible()
    await expect.poll(openedConversationId).not.toBe("")
    const conversationId = openedConversationId()
    await conversationPanel().getByPlaceholder(/message the agent/i).fill("A reply before the rename")
    await conversationPanel().getByRole("button", { name: "Send message" }).click()
    await expect(conversationPanel().getByTestId("conversation-message").getByText("A reply before the rename", { exact: true })).toBeVisible()
    await expect.poll(async () => (await messages(workspaceId, conversationId)).length).toBe(2)

    await page.goto("/settings/profile")
    await page.getByLabel("Display name").fill("   ")
    await page.getByRole("button", { name: "Save changes" }).click()
    await expect(page.locator("form").getByRole("alert")).toHaveText("Enter a display name between 1 and 120 characters.")
    await page.getByLabel("Display name").fill(desiredName)
    await page.getByRole("button", { name: "Save changes" }).click()
    await expect(page.getByRole("status")).toHaveText("Profile saved.")
    await expect(page.getByRole("button", { name: "Account menu", exact: true })).toContainText(desiredName)
    await page.screenshot({ path: testInfo.outputPath("profile-desktop.png"), fullPage: true })
    await page.getByRole("button", { name: "Account menu", exact: true }).click()
    await expect(page.getByRole("link", { name: "Profile", exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByLabel("Display name")).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("profile-mobile.png"), fullPage: true })
    await page.getByRole("button", { name: "Account", exact: true }).click()
    await expect(page.getByRole("link", { name: "Profile", exact: true })).toBeVisible()
    await page.getByRole("link", { name: "Profile", exact: true }).click()
    await page.setViewportSize({ width: 1280, height: 800 })

    await page.goto(`${base}/roadmap`)
    await card.getByRole("button", { name: title }).click()
    await page.locator('[data-slot="sheet-content"]').getByTestId("object-conversations-section").getByRole("button", { name: /^A comment before the rename/ }).click()
    await expect(conversationPanel().getByTestId("conversation-message").getByText("A reply before the rename", { exact: true })).toBeVisible()
    // Past messages now carry the new name; renaming is not an edit.
    const past = await messages(workspaceId, conversationId)
    expect(past.map((message) => message.authorName)).toEqual([desiredName, desiredName])
    for (const message of past) expect(message.editedAt ?? null).toBeNull()
    await conversationPanel().getByPlaceholder(/message the agent/i).fill("A comment after the rename")
    await conversationPanel().getByRole("button", { name: "Send message" }).click()
    await expect(conversationPanel().getByTestId("conversation-message").getByText("A comment after the rename", { exact: true })).toBeVisible()
    await expect.poll(async () => (await messages(workspaceId, conversationId)).map((message) => message.authorName)).toEqual([desiredName, desiredName, desiredName])
    await page.reload()
    await expect(conversationPanel()).toBeVisible()
    await expect(conversationPanel().getByTestId("conversation-message").getByText("A comment after the rename", { exact: true })).toBeVisible()
    expect((await messages(workspaceId, conversationId)).map((message) => message.authorName)).toEqual([desiredName, desiredName, desiredName])
  } catch (error) {
    failed = true
    throw error
  } finally {
    await pool.end()
    if (!page.isClosed()) {
      try {
        await page.goto("/settings/profile")
        await page.getByLabel("Display name").fill(originalName || "Dev User")
        await page.getByRole("button", { name: "Save changes" }).click()
        await expect(page.getByRole("status")).toHaveText("Profile saved.")
      } catch (error) {
        // Preserve the original assertion/timeout if teardown closed the page.
        if (!failed) throw error
      }
    }
  }
})
