import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures/index"

// Functional coverage for multi-question decision requests: one tracked decision
// carrying several questions, each with its own single-choice options. Covers the
// /decisions/new questions editor, the review page's per-question radio groups
// (including a narrow viewport), the Submit answers gate, recorded answers on the
// decided banner and the list, whole-request pushback, and mutual exclusion with
// the single options editor.

type Question = { header?: string; question: string; options: Array<{ label: string; description?: string }> }

async function requestDecisionWithQuestions(page: Page, base: string, title: string, questions: Question[]) {
  await page.goto(`${base}/decisions/new`)
  await page.getByLabel("Decision question").fill(title)
  await page.getByLabel("Context").fill("Context for the multi-question QA spec.")
  await page.getByRole("button", { name: "Add questions" }).click()
  for (let added = 1; added < questions.length; added++) await page.getByRole("button", { name: "Add question" }).click()
  for (const [index, item] of questions.entries()) {
    const n = index + 1
    if (item.header) await page.getByLabel(`Question ${n} header`).fill(item.header)
    await page.getByLabel(`Question ${n} text`).fill(item.question)
    // Each question starts with two option rows; add more as needed.
    for (let count = 2; count < item.options.length; count++) await page.getByRole("button", { name: `Add option to question ${n}` }).click()
    for (const [optionIndex, option] of item.options.entries()) {
      await page.getByLabel(`Question ${n} option ${optionIndex + 1} label`).fill(option.label)
      if (option.description) await page.getByLabel(`Question ${n} option ${optionIndex + 1} description`).fill(option.description)
    }
  }
  await page.getByRole("button", { name: "Request decision" }).click()
  await expect(page.getByRole("heading", { name: title })).toBeVisible()
}

const launchQuestions: Question[] = [
  { header: "Timing", question: "When do we ship?", options: [{ label: "This week", description: "Release before the freeze." }, { label: "Next sprint" }] },
  { question: "Who announces it?", options: [{ label: "Product" }, { label: "Marketing" }, { label: "Founder", description: "A personal note to customers." }] },
]

test.describe("Decision questions", () => {
  test("renders each question as its own radio group with one Submit answers button, gated on every answer", async ({ page, base }) => {
    const title = `Plan the launch ${Date.now()}`
    await requestDecisionWithQuestions(page, base, title, launchQuestions)

    const timing = page.getByRole("group", { name: /When do we ship\?/ })
    const announcer = page.getByRole("group", { name: /Who announces it\?/ })
    await expect(timing).toBeVisible()
    await expect(announcer).toBeVisible()
    await expect(timing.getByRole("radio")).toHaveCount(2)
    await expect(announcer.getByRole("radio")).toHaveCount(3)
    await expect(page.getByText("Release before the freeze.")).toBeVisible()
    await expect(page.getByRole("button", { name: "Request changes" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Reject" })).toBeVisible()

    const submit = page.getByRole("button", { name: "Submit answers" })
    await expect(submit).toBeDisabled()
    await timing.getByRole("radio", { name: /This week/ }).check()
    await expect(submit).toBeDisabled()
    await announcer.getByRole("radio", { name: /Marketing/ }).check()
    await expect(submit).toBeEnabled()
  })

  test("submitting records every answer, shown on the decided banner and in the decisions list", async ({ page, base }) => {
    const title = `Answer every question ${Date.now()}`
    await requestDecisionWithQuestions(page, base, title, launchQuestions)

    await page.getByRole("group", { name: /When do we ship\?/ }).getByRole("radio", { name: /Next sprint/ }).check()
    await page.getByRole("group", { name: /Who announces it\?/ }).getByRole("radio", { name: /Founder/ }).check()
    await page.getByRole("button", { name: "Submit answers" }).click()

    await expect(page.getByText(/Decision recorded:/)).toBeVisible()
    const answers = page.getByRole("list", { name: "Answers" })
    await expect(answers).toContainText("When do we ship?")
    await expect(answers).toContainText("Next sprint")
    await expect(answers).toContainText("Who announces it?")
    await expect(answers).toContainText("Founder")

    await page.goto(`${base}/decisions?tab=decided&q=${encodeURIComponent(title)}`)
    const row = page.getByRole("link").filter({ hasText: title })
    await expect(row).toBeVisible()
    await expect(row.getByText("Approved")).toBeVisible()
    await expect(row.getByText("Next sprint")).toBeVisible()
    await expect(row.getByText("Founder")).toBeVisible()
  })

  test("Request changes applies to the whole request: needs a rationale, not answers", async ({ page, base }) => {
    const title = `Whole-request pushback ${Date.now()}`
    await requestDecisionWithQuestions(page, base, title, launchQuestions)

    await page.getByRole("button", { name: "Request changes" }).click()
    await expect(page.getByText("Add a rationale before rejecting or requesting changes.")).toBeVisible()
    await expect(page.getByText(/Decision recorded:/)).toHaveCount(0)

    await page.getByLabel("Rationale").fill("Both questions are premature; scope the launch first.")
    await page.getByRole("button", { name: "Request changes" }).click()
    await expect(page.getByText(/Decision recorded:/)).toBeVisible()
    await expect(page.getByRole("list", { name: "Answers" })).toHaveCount(0)
    await expect(page.getByRole("link", { name: "Create revised request" })).toBeVisible()
  })

  test("question groups stay legible and unclipped at a narrow viewport", async ({ page, base }) => {
    // Standing rule: responsive layouts must scroll, never squash.
    const title = `Narrow viewport questions ${Date.now()}`
    await requestDecisionWithQuestions(page, base, title, [
      { header: "Rollout", question: "How should we roll the redesigned onboarding flow out to existing workspaces that already completed setup?", options: [{ label: "Keep the current onboarding flow for everyone", description: "No changes; lowest risk, but leaves known drop-off in place and does not address the support ticket volume we have been seeing from new workspace admins." }, { label: "Ship to new workspaces only" }] },
      { question: "Second question?", options: [{ label: "Yes" }, { label: "No" }] },
    ])

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await expect(page.getByRole("group", { name: /How should we roll/ })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    const label = page.getByText("Keep the current onboarding flow for everyone", { exact: true })
    await expect(label).toBeVisible()
    expect((await label.boundingBox())!.width).toBeGreaterThan(150)
    const description = page.getByText(/No changes; lowest risk/)
    await expect(description).toBeVisible()
    expect((await description.boundingBox())!.height).toBeGreaterThan(30)
    await expect(page.getByRole("button", { name: "Submit answers" })).toBeVisible()
  })

  test("the questions editor and the single options editor are mutually exclusive", async ({ page, base }) => {
    await page.goto(`${base}/decisions/new`)
    await page.getByRole("button", { name: "Add answer options" }).click()
    await expect(page.getByRole("button", { name: "Add questions" })).toBeDisabled()
    await page.getByRole("button", { name: "Remove option 1" }).click()
    await page.getByRole("button", { name: "Remove option 1" }).click()
    await page.getByRole("button", { name: "Add questions" }).click()
    await expect(page.getByRole("button", { name: "Add answer options" })).toBeDisabled()
  })

  test("the form explains duplicate and reserved option labels within a question", async ({ page, base }) => {
    await page.goto(`${base}/decisions/new`)
    await page.getByLabel("Decision question").fill("Label rules")
    await page.getByLabel("Context").fill("Checking client-side validation.")
    await page.getByRole("button", { name: "Add questions" }).click()
    await page.getByLabel("Question 1 text").fill("Which?")
    await page.getByLabel("Question 1 option 1 label").fill("Same")
    await page.getByLabel("Question 1 option 2 label").fill("same")
    await page.getByRole("button", { name: "Request decision" }).click()
    await expect(page.locator("form").getByRole("alert")).toContainText("Option labels must be unique")
    await page.getByLabel("Question 1 option 2 label").fill("Reject")
    await page.getByRole("button", { name: "Request decision" }).click()
    await expect(page.locator("form").getByRole("alert")).toContainText("is reserved")
  })

  test("a request without questions keeps the plain Approve / Request changes / Reject buttons", async ({ page, base }) => {
    const title = `Plain approval unchanged ${Date.now()}`
    await page.goto(`${base}/decisions/new`)
    await page.getByLabel("Decision question").fill(title)
    await page.getByLabel("Context").fill("No questions here.")
    await page.getByRole("button", { name: "Request decision" }).click()
    await expect(page.getByRole("heading", { name: title })).toBeVisible()

    await expect(page.getByRole("button", { name: "Submit answers" })).toHaveCount(0)
    await expect(page.getByRole("radio")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Approve" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Request changes" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Reject" })).toBeVisible()
  })
})
