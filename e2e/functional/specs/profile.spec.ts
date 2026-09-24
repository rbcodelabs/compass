import { test, expect } from "../fixtures/index"

test("Profile updates past and future comment names and account navigation", async ({ page, base }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto("/settings/profile")
  const originalName = await page.getByLabel("Display name").inputValue()
  await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute("readonly", "")
  const title = `Profile discussion ${Date.now()}`
  let failed = false
  try {
    await page.goto(`${base}/roadmap`)
    await page.getByRole("button", { name: "Add item" }).nth(1).click()
    await page.getByLabel("Title", { exact: true }).fill(title)
    await page.getByRole("button", { name: "Add Item", exact: true }).click()
    const card = page.locator('[data-slot="card"]').filter({ hasText: title })
    await card.getByRole("button", { name: title }).click()
    let panel = page.locator('[data-slot="sheet-content"]')
    await panel.getByLabel("Add comment").fill("A comment before the rename")
    await panel.getByRole("button", { name: "Post comment" }).click()
    await expect(panel.getByText("A comment before the rename", { exact: true })).toBeVisible()
    await panel.getByRole("button", { name: /^Reply to / }).click()
    await panel.getByRole("textbox", { name: /^Reply to / }).fill("A reply before the rename")
    await panel.getByRole("button", { name: "Post reply" }).click()
    await expect(panel.getByText("A reply before the rename", { exact: true })).toBeVisible()

    await page.goto("/settings/profile")
    await page.getByLabel("Display name").fill("   ")
    await page.getByRole("button", { name: "Save changes" }).click()
    await expect(page.locator("form").getByRole("alert")).toHaveText("Enter a display name between 1 and 120 characters.")
    await page.getByLabel("Display name").fill("Alex Taylor")
    await page.getByRole("button", { name: "Save changes" }).click()
    await expect(page.getByRole("status")).toHaveText("Profile saved.")
    await expect(page.getByRole("button", { name: "Account menu", exact: true })).toContainText("Alex Taylor")
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
    panel = page.locator('[data-slot="sheet-content"]')
    await expect(panel.getByText("Alex Taylor", { exact: true })).toHaveCount(2)
    await expect(panel.getByText("Edited", { exact: true })).toHaveCount(0)
    await panel.getByLabel("Add comment").fill("A comment after the rename")
    await panel.getByRole("button", { name: "Post comment" }).click()
    await expect(panel.getByText("Alex Taylor", { exact: true })).toHaveCount(3)
    await page.reload()
    await expect(panel).toBeVisible()
    await expect(panel.getByText("Alex Taylor", { exact: true })).toHaveCount(3)
  } catch (error) {
    failed = true
    throw error
  } finally {
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
