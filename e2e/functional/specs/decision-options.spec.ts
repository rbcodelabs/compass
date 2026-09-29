import { expect, test } from "../fixtures/index"

// Temporary QA spec for the "question/options on Decision records" feature
// (feat/decision-options). Exercises the /decisions/new options fieldset,
// the review page's radio-choice rendering (including a narrow viewport),
// deciding via a custom option with no rationale, Request changes still
// requiring a rationale when options are present, and the option-less path
// staying byte-identical to the old three-button UI.

async function addOptionRows(page: import("@playwright/test").Page, count: number) {
  // The first click seeds the minimum pair; the button's own label flips
  // from "Add answer options" to "Add option" once any row exists.
  await page.getByRole("button", { name: "Add answer options" }).click()
  for (let added = 2; added < count; added++) {
    await page.getByRole("button", { name: "Add option" }).click()
  }
}

async function requestDecisionWithOptions(
  page: import("@playwright/test").Page,
  base: string,
  question: string,
  options: Array<{ label: string; description?: string }>,
) {
  await page.goto(`${base}/decisions/new`)
  await page.getByLabel("Decision question").fill(question)
  await page.getByLabel("Context").fill("Context for the options-feature QA spec.")
  if (options.length > 0) {
    await addOptionRows(page, options.length)
    for (const [index, option] of options.entries()) {
      await page.getByLabel(`Option ${index + 1} label`).fill(option.label)
      if (option.description) await page.getByLabel(`Option ${index + 1} description`).fill(option.description)
    }
  }
  await page.getByRole("button", { name: "Request decision" }).click()
  await expect(page.getByRole("heading", { name: question })).toBeVisible()
}

test.describe("Decision options", () => {
  test("request with 3 custom options renders option cards with labels and descriptions", async ({ page, base }) => {
    const question = `Which database should we use? ${Date.now()}`
    await requestDecisionWithOptions(page, base, question, [
      { label: "Postgres", description: "Relational, strong consistency, our current default." },
      { label: "DynamoDB" },
      { label: "SQLite", description: "Simple, embedded, no separate server to run." },
    ])

    await expect(page.getByRole("group", { name: "Choose an answer" })).toBeVisible()
    await expect(page.getByText("Postgres", { exact: true })).toBeVisible()
    await expect(page.getByText("Relational, strong consistency, our current default.")).toBeVisible()
    await expect(page.getByText("DynamoDB", { exact: true })).toBeVisible()
    await expect(page.getByText("SQLite", { exact: true })).toBeVisible()
    await expect(page.getByText("Simple, embedded, no separate server to run.")).toBeVisible()
    // Request changes / Reject still offered as pushback below the choices.
    await expect(page.getByRole("button", { name: "Request changes" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Reject" })).toBeVisible()
  })

  test("option cards stay legible and unclipped on a narrow viewport", async ({ page, base }) => {
    // Standing rule: responsive layouts must scroll, never squash — no
    // clipped cards, no page-level horizontal scrollbar at phone widths.
    const question = `Narrow viewport options check ${Date.now()}`
    await requestDecisionWithOptions(page, base, question, [
      { label: "Keep the current onboarding flow", description: "No changes; lowest risk, but leaves known drop-off in place and does not address the support ticket volume we have been seeing from new workspace admins." },
      { label: "Ship the redesigned flow" },
      { label: "Run both behind a flag" },
    ])

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await expect(page.getByRole("group", { name: "Choose an answer" })).toBeVisible()

    // No horizontal overflow at the page level.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    // Each option's label must render at a legible width, not squeezed down
    // to a sliver by a layout that refuses to wrap or scroll.
    const firstOption = page.getByText("Keep the current onboarding flow", { exact: true })
    await expect(firstOption).toBeVisible()
    const box = await firstOption.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThan(150)

    // The long description wraps onto multiple lines instead of being
    // clipped to one — its rendered height should clearly exceed a single
    // line of body text (~20px).
    const description = page.getByText(/No changes; lowest risk/)
    await expect(description).toBeVisible()
    const descriptionBox = await description.boundingBox()
    expect(descriptionBox).not.toBeNull()
    expect(descriptionBox!.height).toBeGreaterThan(30)

    // The confirm control remains reachable at this width.
    await expect(page.getByRole("button", { name: "Confirm choice" })).toBeVisible()
  })

  test("choosing a custom option with no rationale records an approval and shows the chosen option", async ({ page, base, workspaceSlug }) => {
    const question = `Should we adopt the new build cache? ${Date.now()}`
    await requestDecisionWithOptions(page, base, question, [
      { label: "Adopt Turborepo cache", description: "Cuts CI time roughly in half based on the spike." },
      { label: "Stay on the current setup" },
    ])

    await page.getByText("Adopt Turborepo cache", { exact: true }).click()
    await page.getByRole("button", { name: "Confirm choice" }).click()

    await expect(page.getByText(/Decision recorded:/)).toBeVisible()
    await expect(page.getByText("Adopt Turborepo cache", { exact: true })).toBeVisible()
    await expect(page.getByText("Cuts CI time roughly in half based on the spike.")).toBeVisible()

    await page.goto(`${base}/decisions?tab=decided&q=${encodeURIComponent(question)}`)
    const row = page.getByRole("link").filter({ hasText: question })
    await expect(row).toBeVisible()
    await expect(row.getByText("Approved")).toBeVisible()
    await expect(row.getByText("Adopt Turborepo cache")).toBeVisible()
  })

  test("Request changes still requires a rationale when custom options are present", async ({ page, base }) => {
    const question = `Do we need a design review first? ${Date.now()}`
    await requestDecisionWithOptions(page, base, question, [
      { label: "Yes, block on design review" },
      { label: "No, ship without one" },
    ])

    // Blocked without a rationale.
    await page.getByRole("button", { name: "Request changes" }).click()
    await expect(page.getByText("Add a rationale before rejecting or requesting changes.")).toBeVisible()
    await expect(page.getByText(/Decision recorded:/)).toHaveCount(0)

    // Submits once a rationale is provided.
    await page.getByLabel("Rationale").fill("Need the design lead to weigh in before we lock this in.")
    await page.getByRole("button", { name: "Request changes" }).click()
    await expect(page.getByText(/Decision recorded:/)).toBeVisible()
    await expect(page.getByRole("link", { name: "Create revised request" })).toBeVisible()
  })

  test("an option-less decision request still renders the plain Approve / Request changes / Reject buttons", async ({ page, base }) => {
    const question = `Plain approval flow unchanged? ${Date.now()}`
    await requestDecisionWithOptions(page, base, question, [])

    await expect(page.getByRole("group", { name: "Choose an answer" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Approve" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Request changes" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Reject" })).toBeVisible()

    await page.getByRole("button", { name: "Approve" }).click()
    await expect(page.getByText(/Decision recorded:/)).toBeVisible()
    await expect(page.getByText("Approve", { exact: true })).toBeVisible()
  })
})
