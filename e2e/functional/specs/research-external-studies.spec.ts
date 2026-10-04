import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures/index"

/**
 * Journey: Feedback and Research are separate destinations, and a member can record
 * research run outside Compass (UserTesting, Maze, a call they ran) as an external
 * study whose pasted sessions are labelled imported / member-reported.
 *
 * No AI provider is contacted: analysis and synthesis need one, so they are covered by
 * unit tests rather than here.
 */

const TRANSCRIPT = [
  "Interviewer: Walk me through setting up your workspace.",
  "Participant: I invited my team first, which was easy.",
  "Interviewer: Anything that slowed you down?",
  "Participant: I could not find billing and gave up after the third menu.",
].join("\n")

// next-route-announcer is also role=alert, so scope to the form's own message.
const formAlert = (page: Page) => page.locator('p[role="alert"]')

async function createExternalStudy(page: Page, base: string, name: string) {
  await page.goto(`${base}/capture/new/external`)
  await page.getByLabel("Study name").fill(name)
  await page.getByLabel("Research goal").fill("Understand where new admins get stuck during setup")
  await page.getByLabel("Where was it run?").selectOption("USERTESTING")
  await page.getByLabel("Link to the study (optional)").fill("https://app.usertesting.com/studies/e2e")
  await page.getByRole("button", { name: "Create external study" }).click()
  await expect(page).toHaveURL(/\/capture\/studies\/[a-f0-9-]+$/, { timeout: 30_000 })
}

test.describe("Research — external studies", () => {
  test("shows Feedback and Research as separate destinations and retitles the capture page", async ({ page, base }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${base}/capture`)

    const sidebar = page.getByRole("navigation", { name: "Main navigation" })
    await expect(sidebar.getByRole("link", { name: "Feedback", exact: true })).toHaveAttribute("href", `${base}/feedback`)
    await expect(sidebar.getByRole("link", { name: "Research", exact: true })).toHaveAttribute("href", `${base}/capture`)
    await expect(sidebar.getByRole("link", { name: "Capture", exact: true })).toHaveCount(0)

    await expect(page.getByRole("heading", { name: "Research", exact: true })).toBeVisible()
    await expect(page).toHaveTitle(/Research/)
    await expect(page.getByRole("link", { name: "Manual / external study" })).toBeVisible()
    await expect(page.getByRole("link", { name: "New study" })).toBeVisible()
    // The Studies / Inbox tab strip is gone.
    await expect(page.getByRole("link", { name: "Inbox", exact: true })).toHaveCount(0)
    await expect(page.getByRole("link", { name: "Studies", exact: true })).toHaveCount(0)

    // The feedback log still works on its own.
    await sidebar.getByRole("link", { name: "Feedback", exact: true }).click()
    await expect(page).toHaveURL(`${base}/feedback`)
    await expect(page.getByRole("heading", { name: "Feedback", exact: true })).toBeVisible()
  })

  test("shows both destinations in the mobile bottom navigation", async ({ page, base }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${base}/capture`)
    const bottomNav = page.getByRole("navigation", { name: "Primary navigation" })
    await expect(bottomNav.getByRole("link", { name: "Feedback", exact: true })).toHaveAttribute("href", `${base}/feedback`)
    const research = bottomNav.getByRole("link", { name: "Research", exact: true })
    await expect(research).toHaveAttribute("href", `${base}/capture`)
    await expect(research).toHaveAttribute("aria-current", "page")
  })

  test("creates an external study, saves one session for a double submit, and labels it imported", async ({ page, base }) => {
    const name = `E2E external study ${Date.now()}`
    await createExternalStudy(page, base, name)

    await expect(page.getByRole("heading", { name })).toBeVisible()
    await expect(page.getByText("External study (imported)")).toBeVisible()
    await expect(page.getByText("UserTesting", { exact: true })).toBeVisible()
    // No participant link machinery for a study Compass does not interview.
    await expect(page.getByRole("heading", { name: "Participant link" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /Activate study|Close study|Rotate participant link|Generate participant link/ })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Archive study" })).toBeVisible()

    await page.getByLabel("Participant name (optional)").fill("Pat Tester")
    await page.getByLabel("Participant email (optional)").fill("pat@example.com")
    await page.getByLabel("Session date (optional)").fill("2026-09-20")
    await page.getByLabel("Link to the session (optional)").fill("https://app.usertesting.com/sessions/e2e")
    await page.getByLabel("Transcript", { exact: true }).fill(TRANSCRIPT)
    await page.getByLabel("Notes or summary").fill("Pat hesitated at billing.")
    // Two submissions of the same rendered form (a double click) must create one session.
    await page.locator('input[name="idempotencyKey"]').evaluate((input) => {
      const form = (input as HTMLInputElement).form!
      form.requestSubmit()
      form.requestSubmit()
    })

    const sessions = page.locator("article")
    await expect(sessions).toHaveCount(1, { timeout: 30_000 })
    await page.reload()
    await expect(sessions).toHaveCount(1)
    await expect(sessions.first().getByText("Imported from an external source")).toBeVisible()
    await expect(sessions.first().getByText(/Member-reported; Compass has not verified it/)).toBeVisible()
    await expect(sessions.first().getByText("Participant: Pat Tester · pat@example.com")).toBeVisible()
    await expect(sessions.first().getByText("4 saved turns")).toBeVisible()
    await expect(page.getByLabel("Transcript", { exact: true })).toHaveValue("")

    await sessions.first().getByRole("link", { name: "View full interview and attachments" }).click()
    await expect(page.getByRole("heading", { name: "External session" })).toBeVisible()
    await expect(page.getByText("Imported from an external source")).toBeVisible()
    await expect(page.getByText("Pat hesitated at billing.")).toBeVisible()
    await expect(page.getByText("I could not find billing and gave up after the third menu.")).toBeVisible()
    await expect(page.getByText("Interviewer:", { exact: true }).first()).toBeVisible()

    // A second, separately submitted session is not mistaken for a replay.
    await page.getByRole("link", { name: "Back to study" }).click()
    await expect(page).toHaveURL(/\/capture\/studies\/[a-f0-9-]+$/)
    await page.getByLabel("Transcript", { exact: true }).fill("Participant: A second, different session.")
    await page.getByRole("button", { name: "Save session" }).click()
    await expect(sessions).toHaveCount(2, { timeout: 30_000 })

    // The new study is listed with its provider.
    await page.goto(`${base}/capture`)
    await expect(page.getByRole("link", { name: new RegExp(`External study · UserTesting\\s*${name}`) })).toBeVisible()
  })

  test("explains a rejected submission inline and keeps what was typed", async ({ page, base }) => {
    await page.goto(`${base}/capture/new/external`)
    await page.getByLabel("Study name").fill(`E2E rejected link ${Date.now()}`)
    await page.getByLabel("Research goal").fill("Goal")
    await page.getByLabel("Where was it run?").selectOption("MAZE")
    await page.getByLabel("Link to the study (optional)").fill("http://insecure.example.com/study")
    await page.getByRole("button", { name: "Create external study" }).click()
    await expect(formAlert(page)).toContainText("must use HTTPS")
    await expect(page).toHaveURL(`${base}/capture/new/external`)
    await expect(page.getByLabel("Where was it run?")).toHaveValue("MAZE")
    await expect(page.getByLabel("Research goal")).toHaveValue("Goal")

    await createExternalStudy(page, base, `E2E validation ${Date.now()}`)
    const sessions = page.locator("article")
    const save = page.getByRole("button", { name: "Save session" })

    await save.click()
    await expect(formAlert(page)).toHaveText("Add a transcript or notes for this session")

    await page.getByLabel("Transcript", { exact: true }).fill("Participant: keep this text")
    await page.getByLabel("Session date (optional)").fill("2999-01-01")
    await save.click()
    await expect(formAlert(page)).toHaveText("The session date cannot be in the future")
    await expect(page.getByLabel("Transcript", { exact: true })).toHaveValue("Participant: keep this text")

    await page.getByLabel("Session date (optional)").fill("2026-09-01")
    await page.getByLabel("Link to the session (optional)").fill("http://insecure.example.com/session")
    await save.click()
    await expect(formAlert(page)).toContainText("must use HTTPS")

    await page.getByLabel("Link to the session (optional)").fill("")
    await page.getByLabel("Transcript", { exact: true }).evaluate((el) => { (el as HTMLTextAreaElement).value = `Participant: ${"x".repeat(60_001)}` })
    await save.click()
    await expect(formAlert(page)).toHaveText("Transcript must be 60,000 characters or fewer")
    await expect(sessions).toHaveCount(0)

    // Nothing was stored by the rejections, and a corrected submission succeeds and clears the message.
    await page.getByLabel("Transcript", { exact: true }).fill("Participant: keep this text")
    await save.click()
    await expect(sessions).toHaveCount(1, { timeout: 30_000 })
    await expect(formAlert(page)).toHaveCount(0)
    await expect(page.getByLabel("Transcript", { exact: true })).toHaveValue("")
  })
})
