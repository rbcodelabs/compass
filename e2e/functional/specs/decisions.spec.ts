import { expect, test } from "../fixtures/index"

test.describe("Decisions", () => {
  test("request → request changes → revise → approve", async ({ page, base }) => {
    const question = `Should we ship the simple decision flow? ${Date.now()}`
    await page.goto(`${base}/decisions`)
    await expect(page.getByRole("heading", { name: "Decisions", exact: true })).toBeVisible()
    await page.getByRole("link", { name: "New decision" }).click()
    await page.getByLabel("Decision question").fill(question)
    await page.getByLabel("Context").fill("The team needs one clear, recorded call.")
    await page.getByRole("button", { name: "Request decision" }).click()

    await expect(page.getByRole("heading", { name: question })).toBeVisible()
    await page.getByLabel("Rationale").fill("Clarify the empty state before shipping.")
    await page.getByRole("button", { name: "Request changes" }).click()
    await expect(page.getByText(/Decision recorded:/)).toBeVisible()
    await page.getByRole("link", { name: "Create revised request" }).click()
    await expect(page.getByLabel("Decision question")).toHaveValue(question)
    await page.getByLabel("Context").fill("The empty state is now clear and actionable.")
    await page.getByRole("button", { name: "Request decision" }).click()

    await page.getByRole("button", { name: "Approve" }).click()
    await expect(page.getByText(/Decision recorded:/)).toBeVisible()
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible()
    await page.goto(`${base}/decisions?tab=decided&q=${encodeURIComponent(question)}`)
    await expect(page.getByText(question).first()).toBeVisible()
  })
})
