import { randomUUID } from "node:crypto"
import pg from "pg"
import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures/index"
import { assertIsolatedE2EDatabase, isolatedE2EConnectionString } from "../fixtures/isolated-database"

// Synthetic fixtures only; the suite's guarded, run-owned workspace teardown
// removes these records. No configured MCP keys or external research providers.
async function seedRelationshipFixtures(prefix: string, hasParticipation = false) {
  await assertIsolatedE2EDatabase()
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() })
  const experiment = { id: randomUUID(), title: `${prefix} — improve plan selection` }
  const secondExperiment = { id: randomUUID(), title: `${prefix} — clarify billing` }
  const study = { id: randomUUID(), name: `${prefix} — plan selection study` }
  const interview = { id: randomUUID(), name: `${prefix} — customer interview` }
  try {
    const { rows: [workspace] } = await pool.query<{ id: string }>(`
      SELECT w.id FROM compass_dev.workspaces w
      JOIN compass_dev.organizations o ON o.id = w.organization_id
      WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace'
    `)
    expect(workspace).toBeTruthy()
    for (const item of [experiment, secondExperiment]) {
      await pool.query(`INSERT INTO compass_dev.experiments
        (id, workspace_id, title, hypothesis, method, kill_condition)
        VALUES ($1, $2, $3, 'Clear comparisons help people choose a plan.',
          'Observe plan selection in a prototype.', 'Reconsider if people cannot explain their choice.')`,
      [item.id, workspace.id, item.title])
    }
    for (const [item, studyType, status] of [[study, "USABILITY_TEST", hasParticipation ? "CLOSED" : "DRAFT"], [interview, "CUSTOMER_INTERVIEW", "CLOSED"]] as const) {
      await pool.query(`INSERT INTO compass_dev.research_studies
        (id, workspace_id, name, goal, study_type, guide, status, app_url)
        VALUES ($1, $2, $3, 'Understand how people choose plans.', $4, $5, $6, $7)`,
      [item.id, workspace.id, item.name, studyType,
        JSON.stringify([{ id: "1", text: "Find the plan that fits your team." }]), status,
        studyType === "USABILITY_TEST" ? "https://example.com/plans" : null])
    }
    if (hasParticipation) {
      await pool.query(`INSERT INTO compass_dev.research_sessions (study_id, status, modality, created_at, completed_at)
        VALUES ($1, 'COMPLETED', 'CHAT', '2026-01-01T12:00:00Z', '2026-01-01T12:15:00Z')`, [study.id])
    }
    return { experiment, secondExperiment, study, interview }
  } finally {
    await pool.end()
  }
}

async function chooseExisting(page: Page, type: "study" | "experiment", title: string, screenshotName?: string) {
  await page.getByRole("button", { name: `Link existing ${type}`, exact: true }).click()
  const dialog = page.getByRole("dialog", { name: `Link existing ${type}`, exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("combobox").click()
  const search = page.getByPlaceholder(type === "study" ? "Search studies…" : "Search experiments…", { exact: true })
  await search.fill(title)
  await expect(page.getByRole("option")).toHaveCount(1)
  await expect(page.getByRole("option").filter({ hasText: title })).toHaveCount(1)
  if (screenshotName) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await capture(page, screenshotName)
  }
  // Keyboard selection verifies the picker remains usable inside the modal
  // experiment sheet as well as on the full-page study surface.
  await search.press("ArrowDown")
  await search.press("Enter")
  await expect(dialog.getByRole("combobox")).toContainText(title)
  const submit = dialog.getByRole("button", { name: `Link ${type}`, exact: true })
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole("button", { name: `Link existing ${type}`, exact: true })).toBeEnabled()
}

async function capture(page: Page, name: string) {
  if (process.env.RESEARCH_QA_SCREENSHOTS === "1") {
    await page.screenshot({
      path: `public/screenshots/docs/${name}.png`, fullPage: true, animations: "disabled",
      // Hide only Next's developer badge in documentation; application warnings
      // and errors remain visible and the full dev diagnostics stay in the log.
      style: "nextjs-portal { visibility: hidden !important; }",
    })
  }
}

test("links research in both directions without changing experiment or study lifecycle", async ({ page, base }) => {
  test.setTimeout(150_000)
  const { experiment, secondExperiment, study, interview } = await seedRelationshipFixtures("Research links", true)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`${base}/experiments?detail=${encodeURIComponent(`experiment:${experiment.id}`)}`)
  const panel = page.locator('[data-slot="sheet-content"]')
  await expect(panel.getByText(experiment.title, { exact: true })).toBeVisible()
  await chooseExisting(page, "study", study.name)
  await expect(panel.getByRole("link", { name: study.name, exact: true })).toBeVisible()
  await chooseExisting(page, "study", interview.name)
  await expect(panel.getByRole("link", { name: interview.name, exact: true })).toBeVisible()
  await panel.getByRole("region", { name: "Research studies", exact: true }).evaluate(element => element.scrollIntoView({ block: "start" }))
  await capture(page, "experiment-research-links-panel-desktop")

  await panel.getByRole("link", { name: study.name, exact: true }).click()
  await expect(page).toHaveURL(`${base}/capture/studies/${study.id}`)
  await expect(page.getByText(/protocol is locked/i)).toBeVisible()
  await expect(page.getByRole("link", { name: experiment.title, exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await chooseExisting(page, "experiment", secondExperiment.title, "research-study-experiment-picker-mobile")
  await expect(page.getByRole("link", { name: secondExperiment.title, exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 800 })
  await capture(page, "research-study-experiment-links-desktop")

  await page.setViewportSize({ width: 390, height: 844 })
  const experiments = page.getByRole("region", { name: "Experiments", exact: true })
  await experiments.scrollIntoViewIfNeeded()
  await expect(experiments.getByRole("button", { name: `Unlink ${experiment.title}`, exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await capture(page, "research-study-experiment-links-mobile")
  await experiments.getByRole("button", { name: `Unlink ${experiment.title}`, exact: true }).click()
  await expect(experiments.getByRole("link", { name: experiment.title, exact: true })).toHaveCount(0)
  await expect(experiments.getByRole("link", { name: secondExperiment.title, exact: true })).toBeVisible()

  await page.goto(`${base}/experiments/${experiment.id}`)
  const studies = page.getByRole("region", { name: "Research studies", exact: true })
  await expect(studies.getByRole("link", { name: study.name, exact: true })).toHaveCount(0)
  await expect(studies.getByRole("link", { name: interview.name, exact: true })).toBeVisible()
  await studies.evaluate(element => element.scrollIntoView({ block: "start" }))
  await studies.getByRole("button", { name: "Link existing study", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Link existing study", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Link existing study", exact: true })).not.toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await capture(page, "experiment-research-links-mobile")
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByRole("heading", { name: experiment.title, exact: true }).evaluate(element => element.scrollIntoView({ block: "start" }))
  await capture(page, "experiment-research-links-desktop")

  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() })
  try {
    const { rows } = await pool.query(`SELECT status, conclusion FROM compass_dev.experiments WHERE id = ANY($1::uuid[])`, [[experiment.id, secondExperiment.id]])
    expect(rows).toEqual([{ status: "DESIGNING", conclusion: null }, { status: "DESIGNING", conclusion: null }])
    expect((await pool.query(`SELECT status FROM compass_dev.research_studies WHERE id=$1`, [study.id])).rows).toEqual([{ status: "CLOSED" }])
    expect((await pool.query(`SELECT count(*)::int AS count FROM compass_dev.experiment_results WHERE experiment_id = ANY($1::uuid[])`, [[experiment.id, secondExperiment.id]])).rows[0].count).toBe(0)
  } finally {
    await pool.end()
  }
})

test("retains archived study links while excluding archived studies from new links", async ({ page, base }) => {
  const { experiment, secondExperiment, study } = await seedRelationshipFixtures("Archived research")
  await page.goto(`${base}/experiments/${experiment.id}`)
  await chooseExisting(page, "study", study.name)
  await page.getByRole("link", { name: study.name, exact: true }).click()
  page.once("dialog", dialog => dialog.accept())
  await page.getByRole("button", { name: "Archive study", exact: true }).click()
  await expect(page).toHaveURL(`${base}/capture`)
  await page.goto(`${base}/experiments/${experiment.id}`)
  const studies = page.getByRole("region", { name: "Research studies", exact: true })
  await expect(studies.getByRole("link", { name: study.name, exact: true })).toBeVisible()
  await expect(studies.getByText("Archived", { exact: true })).toBeVisible()
  await studies.getByRole("link", { name: study.name, exact: true }).click()
  await expect(page.getByRole("link", { name: experiment.title, exact: true })).toBeVisible()

  await page.goto(`${base}/experiments/${secondExperiment.id}`)
  await page.getByRole("button", { name: "Link existing study", exact: true }).click()
  await page.getByRole("dialog", { name: "Link existing study", exact: true }).getByRole("combobox").click()
  await page.getByPlaceholder("Search studies…", { exact: true }).fill(study.name)
  await expect(page.getByRole("option").filter({ hasText: study.name })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await page.goto(`${base}/experiments/${experiment.id}`)
  await studies.getByRole("button", { name: `Unlink ${study.name}`, exact: true }).click()
  await expect(studies.getByRole("link", { name: study.name, exact: true })).toHaveCount(0)
})
