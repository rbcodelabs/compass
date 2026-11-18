import { test, expect } from "../fixtures/index"

// The dev server compiles a route the first time it is visited; allow for that after a click.
const NAVIGATE_MS = 30_000

/**
 * Journey: the shared settings shell. Every settings screen (account, workspace,
 * organization) shows the same scope-grouped navigation, marks the current page,
 * and offers one way back to the app. On a phone the same list opens in a sheet
 * instead of a clipped strip.
 *
 * Covers admin visibility only (the seeded user is an organization admin). The
 * member and platform-admin variants are covered by the unit tests in
 * lib/settings-nav.test.ts, which exercise the pure nav definition.
 */
test.describe("settings shell", () => {
  test("desktop: grouped nav, current page and a single way back", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto("/settings/profile")

    const nav = page.getByRole("navigation", { name: "Settings", exact: true })
    await expect(nav).toBeVisible()
    await expect(nav.getByRole("link", { name: "Profile", exact: true })).toHaveAttribute("aria-current", "page")
    for (const name of ["Passkeys", "My agents", "Workspace settings", "Modules", "Organization settings"]) {
      await expect(nav.getByRole("link", { name, exact: true })).toBeVisible()
    }
    // One back link, not one from the shell plus one from the page.
    await expect(page.getByRole("link", { name: "Back to Compass" })).toHaveCount(1)

    await nav.getByRole("link", { name: "My agents", exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/agents$/, { timeout: NAVIGATE_MS })
    await expect(nav.getByRole("link", { name: "My agents", exact: true })).toHaveAttribute("aria-current", "page")
    await expect(nav.getByRole("link", { name: "Profile", exact: true })).not.toHaveAttribute("aria-current", "page")
    await expect(page.getByRole("link", { name: "Back to Compass" })).toHaveCount(1)
  })

  test("desktop: the workspace and organization trees use the same nav", async ({ page, base }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const nav = page.getByRole("navigation", { name: "Settings", exact: true })

    await page.goto(`${base}/settings`)
    await expect(nav.getByRole("link", { name: "Workspace settings", exact: true })).toHaveAttribute("aria-current", "page")

    // Modules is a child path of workspace settings; the longer match must win.
    await nav.getByRole("link", { name: "Modules", exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/modules$/, { timeout: NAVIGATE_MS })
    await expect(nav.getByRole("link", { name: "Modules", exact: true })).toHaveAttribute("aria-current", "page")
    await expect(nav.getByRole("link", { name: "Workspace settings", exact: true })).not.toHaveAttribute("aria-current", "page")

    await nav.getByRole("link", { name: "Organization settings", exact: true }).click()
    await expect(nav.getByRole("link", { name: "Organization settings", exact: true })).toHaveAttribute("aria-current", "page", { timeout: NAVIGATE_MS })
    await expect(nav.getByRole("link", { name: "Profile", exact: true })).toBeVisible()
  })

  test("account and organization settings name the workspace you came from", async ({ page, base }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const nav = page.getByRole("navigation", { name: "Settings", exact: true })
    const remembered = base.replace(/^\//, "")

    // The seeded organization has two workspaces and "E2E Planning" sorts first, so naming
    // "E2E Workspace" proves the remembered one is used rather than the first in the list.
    await page.goto(`${base}/settings`)
    await expect
      .poll(async () => (await page.context().cookies()).some((c) => c.name === "compass_last_workspace" && c.value === remembered), { timeout: NAVIGATE_MS })
      .toBe(true)

    await page.goto("/settings/profile")
    await expect(nav.getByText("E2E Workspace", { exact: true })).toBeVisible({ timeout: NAVIGATE_MS })
    await expect(nav.getByText("E2E Planning", { exact: true })).toHaveCount(0)

    await nav.getByRole("link", { name: "Organization settings", exact: true }).click()
    await expect(nav.getByRole("link", { name: "Organization settings", exact: true })).toHaveAttribute("aria-current", "page", { timeout: NAVIGATE_MS })
    await expect(nav.getByText("E2E Workspace", { exact: true })).toBeVisible()
    await expect(nav.getByText("E2E Planning", { exact: true })).toHaveCount(0)
  })

  test("mobile: the nav opens in a sheet and reaches every group", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto("/settings/profile")

    // The desktop rail is hidden on a phone; the bar shows where you are.
    await expect(page.getByRole("navigation", { name: "Settings", exact: true })).toBeHidden()
    const trigger = page.getByRole("button", { name: /^Settings menu, current page Profile/ })
    await expect(trigger).toBeVisible()
    await expect(page.getByRole("link", { name: "Back to Compass" })).toHaveCount(1)

    await trigger.click()
    const sheet = page.locator('[data-slot="sheet-content"]')
    const sheetNav = sheet.getByRole("navigation", { name: "Settings sections" })
    await expect(sheetNav).toBeVisible()
    // Nothing is clipped or off-screen: the organization group is reachable.
    await expect(sheetNav.getByRole("link", { name: "Organization settings", exact: true })).toBeVisible()
    await expect(sheetNav.getByRole("link", { name: "Profile", exact: true })).toHaveAttribute("aria-current", "page")

    await sheetNav.getByRole("link", { name: "Passkeys", exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/passkeys$/, { timeout: NAVIGATE_MS })
    await expect(sheet).toBeHidden()
    await expect(page.getByRole("button", { name: /^Settings menu, current page Passkeys/ })).toBeVisible({ timeout: NAVIGATE_MS })
  })
})
