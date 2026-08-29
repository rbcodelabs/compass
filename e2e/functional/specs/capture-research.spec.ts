import { test, expect } from "../fixtures/index"

test.describe("Capture — research study", () => {
  test("create a study and start its secure participant interview", async ({ page, base, browser, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${base}/capture/new`)
    await page.getByLabel("Study name").fill(`E2E interview ${Date.now()}`)
    await page.getByLabel("What are you trying to learn?").fill("How customers currently plan their work")
    await page.getByLabel("Discussion guide").fill("Tell me about the last time you planned your week.\nWhat was difficult?")
    await page.getByRole("button", { name: "Create study" }).click()

    await expect(page).toHaveURL(/\/capture\/studies\/[a-f0-9-]+\?token=/)
    const shareUrl = await page.getByRole("textbox").inputValue()
    expect(shareUrl).toContain("/research/")

    const anonymous = await browser.newContext({ storageState: undefined })
    const participant = await anonymous.newPage()
    await participant.setViewportSize({ width: 390, height: 844 })
    await participant.goto(shareUrl.replace(/^https?:\/\/[^/]+/, baseURL!))
    await expect(participant.getByRole("heading", { name: /E2E interview/ })).toBeVisible()
    await participant.getByRole("button", { name: "Start interview" }).click()
    await expect(participant.getByText("Tell me about the last time you planned your week.")).toBeVisible()
    expect(await participant.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await anonymous.close()
  })
})
