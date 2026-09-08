import { test, expect } from "../fixtures/index"
import { E2E_SECOND_WORKSPACE_SLUG } from "../fixtures/seed-e2e"

test.describe("Marketing navigation", () => {
  test("anonymous visitors see sign-in navigation without account controls", async ({ browser, baseURL }) => {
    // Explicitly override the functional project's authenticated storage state.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const page = await context.newPage()
    await page.goto(baseURL || "/")

    await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Account menu" })).toHaveCount(0)
    await context.close()
  })

  test("authenticated users can choose either authorized workspace", async ({ page, orgSlug, workspaceSlug }) => {
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible()

    await page.getByRole("button", { name: "Choose workspace" }).click()
    await expect(page.getByRole("link", { name: /E2E Workspace/ })).toHaveAttribute(
      "href",
      `/${orgSlug}/${workspaceSlug}/okrs`
    )
    const planning = page.getByRole("link", { name: /E2E Planning/ })
    await expect(planning).toHaveAttribute("href", `/${orgSlug}/${E2E_SECOND_WORKSPACE_SLUG}/okrs`)
    await planning.click()

    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/${E2E_SECOND_WORKSPACE_SLUG}/okrs/?$`))
    await expect(page.getByRole("heading", { name: "OKRs" })).toBeVisible()
  })
})
