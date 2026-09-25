import { expect, test } from "../fixtures/index"

test.describe("Workspace search", () => {
  test("searches every supported title type, navigates, and isolates workspaces", async ({ page, base }) => {
    // Own the doc fixture in this test. Earlier docs journeys intentionally
    // mutate the shared workspace, so relying on a global baseline doc makes
    // this late-running search journey order-dependent.
    const searchDocTitle = `E2E Baseline Workspace Search Doc ${Date.now()}`
    await page.goto(`${base}/docs`)
    await page.waitForLoadState("networkidle")
    await page.getByRole("button", { name: "New" }).click()
    await page.waitForURL(/\/docs\/[0-9a-f-]+$/, { timeout: 15_000 })
    const titleInput = page.getByPlaceholder("Untitled")
    await expect(titleInput).toBeVisible({ timeout: 10_000 })
    const titleSave = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.request().headers()["next-action"] !== undefined &&
        response.ok()
    )
    await titleInput.fill(searchDocTitle)
    await titleInput.blur()
    await titleSave

    await page.goto(`${base}/roadmap`)
    await page.waitForLoadState("networkidle")

    await page.keyboard.press("Control+k")
    const search = page.getByRole("combobox", { name: "Search workspace" })
    await search.fill("e2e baseline")

    const expected = [
      ["Opportunities", "E2E Baseline Opportunity", /\/discovery\/[^?]+$/],
      ["Solutions", "E2E Baseline Solution", /\/discovery\/[^?]+\?detail=solution/],
      ["Experiments", "E2E Baseline Experiment", /\/experiments\/[^?]+$/],
      ["Roadmap", "E2E Baseline Roadmap", /\/roadmap\?detail=roadmapItem/],
      ["Tasks", "E2E Baseline Task", /\/tasks\/[^?]+$/],
      ["Feedback", "E2E Baseline Feedback", /\/feedback\?detail=feedback/],
      ["Docs", searchDocTitle, /\/docs\/[^?]+$/],
    ] as const

    for (const [index, [group, title]] of expected.entries()) {
      await expect(page.getByRole("group", { name: group }).getByRole("option", { name: new RegExp(title) })).toBeVisible({
        // The first search compiles the new API route in Next dev mode.
        timeout: index === 0 ? 15_000 : 5_000,
      })
    }

    const [firstGroup, firstTitle, firstDestination] = expected[0]
    await page.getByRole("group", { name: firstGroup }).getByRole("option", { name: new RegExp(firstTitle) }).click()
    await expect(page).toHaveURL(firstDestination)
    await page.goBack()
    await expect(page).toHaveURL(`${base}/roadmap`)
    await page.keyboard.press("Control+k")
    await page.getByRole("combobox", { name: "Search workspace" }).fill("e2e baseline")

    for (const [group, title, destination] of expected.slice(1)) {
      await page.getByRole("group", { name: group }).getByRole("option", { name: new RegExp(title) }).click()
      // Each hop is a soft navigation to a different route; the first visit to a
      // route compiles it in dev, which has taken longer than the 5s default.
      await expect(page).toHaveURL(destination, { timeout: 15_000 })
      await page.keyboard.press("Control+k")
      await page.getByRole("combobox", { name: "Search workspace" }).fill("e2e baseline")
      await expect(page.getByRole("group", { name: group }).getByRole("option", { name: new RegExp(title) })).toBeVisible()
    }

    // The palette also searches the User Guide (#218), whose articles match
    // ordinary words like "search", so the empty-state probe needs a term that
    // exists in neither the workspace nor the guide.
    const unmatched = `zqxforeign${Date.now()}`
    await page.getByRole("combobox", { name: "Search workspace" }).fill(unmatched)
    await expect(page.getByText(`No results for “${unmatched}”`)).toBeVisible()
  })
})
