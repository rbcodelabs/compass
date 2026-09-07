import { test, expect } from "../fixtures/index"
import pg from "pg"
import { assertIsolatedE2EDatabase } from "../fixtures/isolated-database"

test("research results: summaries, coverage, synthesis history and paginated evidence", async ({ page, base }, testInfo) => {
  test.setTimeout(120_000)
  const analyze = async (buttonName: string) => {
    const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/research/analysis") && response.request().method() === "POST")
    await page.getByRole("button", { name: buttonName, exact: true }).click()
    const response = await responsePromise
    expect(response.status(), await response.text()).toBe(200)
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  await assertIsolatedE2EDatabase()
  const schema = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev"
  // Seed only the owned functional-test workspace; never real customer research.
  const client = await pool.connect()
  let studyId = ""
  let sessionId = ""
  try {
    await client.query(`SET search_path TO "${schema}"`)
    const workspace = await client.query("SELECT w.id FROM workspaces w JOIN organizations o ON o.id=w.organization_id WHERE o.slug='e2e-test-org' AND w.slug='e2e-workspace'")
    const study = await client.query("INSERT INTO research_studies (workspace_id,name,goal,guide,status) VALUES ($1,'Research results review','Understand planning friction',$2,'CLOSED') RETURNING id", [workspace.rows[0].id, JSON.stringify([{ id: "q1", text: "Tell me about planning." }])])
    studyId = study.rows[0].id
    for (let i = 0; i < 21; i++) {
      const session = await client.query("INSERT INTO research_sessions (study_id,status,modality,completed_at,created_at) VALUES ($1,'COMPLETED',$2,now(),now() - $3::interval) RETURNING id", [studyId, i === 0 ? "VOICE" : "CHAT", `${i} minutes`])
      if (i === 0) sessionId = session.rows[0].id
      for (let turn = 0; turn < (i === 0 ? 52 : 1); turn++) await client.query("INSERT INTO research_turns (session_id,role,content,sequence) VALUES ($1,'PARTICIPANT',$2,$3)", [session.rows[0].id, `Saved planning evidence ${i + 1}, turn ${turn + 1}.`, turn])
    }
  } finally { client.release(); await pool.end() }
  const studyUrl = `${base}/capture/studies/${studyId}`
  await page.goto(studyUrl)
  await expect(page.getByText("Page 1 · 21 sessions")).toBeVisible()
  await page.getByRole("link", { name: "Next sessions" }).click()
  await expect(page.getByText("Page 2 · 21 sessions")).toBeVisible()
  await page.goto(`${studyUrl}/sessions/${sessionId}`)
  await analyze("Generate summary")
  await expect(page.getByText("Test analysis: participant described their experience.", { exact: true })).toBeVisible()
  await analyze("Check guide coverage")
  await expect(page.getByText("Not addressed:")).toBeVisible()
  await page.getByRole("link", { name: "Next turns" }).click()
  await expect(page.getByText("Saved planning evidence 1, turn 52.", { exact: true })).toBeVisible()
  await page.goto(studyUrl)
  await analyze("Generate synthesis")
  await expect(page.getByText("Test synthesis from saved sessions.", { exact: true })).toBeVisible()
  await analyze("Regenerate synthesis")
  await expect(page.locator('[data-slot="collapsible"]')).toHaveCount(2)
  await expect(page.getByText("Test synthesis from saved sessions.", { exact: true }).first()).toBeVisible()
  const evidenceHref = await page.getByRole("link", { name: "View saved evidence" }).first().getAttribute("href")
  await page.getByRole("link", { name: "View saved evidence" }).first().click()
  await expect(page).toHaveURL(/\/sessions\/.+\?turnId=/)
  const evidenceUrl = new URL(evidenceHref!, "http://localhost")
  expect(new URL(page.url()).hash).toBe(evidenceUrl.hash)
  await expect(page.locator(`[id="turn-${evidenceUrl.searchParams.get("turnId")}"]`)).toBeVisible()
  await expect(page.locator(`[id="turn-${evidenceUrl.searchParams.get("turnId")}"]`)).toBeInViewport()
  await page.goto(studyUrl)
  for (const [label, width, height] of [["desktop", 1280, 800], ["mobile", 390, 844]] as const) {
    await page.setViewportSize({ width, height })
    await expect(page.getByRole("heading", { name: "Research results review" })).toBeVisible()
    // The workspace scrolls inside its shell; fullPage alone captures settings,
    // not the results being verified. Position the actual synthesis in view.
    const synthesisHeading = page.getByRole("heading", { name: "Cross-session synthesis" })
    await synthesisHeading.evaluate(element => element.scrollIntoView({ block: "start" }))
    await expect(synthesisHeading).toBeInViewport()
    await expect(page.getByRole("heading", { name: "Executive summary" })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`research-results-${label}.png`), fullPage: true })
    if (process.env.UPDATE_RESEARCH_RESULTS_SCREENSHOTS === "1") await page.screenshot({ path: `public/screenshots/docs/capture-results-${label}.png`, fullPage: true })
  }
  const denied = await page.goto(`/rbcodelabs/compass/capture/studies/${studyId}/sessions/${sessionId}`)
  expect(denied?.status()).toBe(404)
})
