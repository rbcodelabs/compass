import { test, expect } from "../fixtures/index"
import pg from "pg"
import { createHash } from "node:crypto"
import { assertIsolatedE2EDatabase } from "../fixtures/isolated-database"

/**
 * Mirrors `guideFingerprint` in lib/research-analysis.ts. Replicated rather than
 * imported because no other spec in this suite pulls a `@/` module, and a
 * seeded snapshot whose fingerprint disagrees with the study's would render as
 * "New source data available" — which would then leak into the committed docs
 * screenshots this test regenerates.
 */
const fingerprint = (goal: string, guide: unknown) => createHash("sha256").update(JSON.stringify({ goal, guide })).digest("hex")

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
    const goal = "Understand planning friction"
    const guide = [{ id: "q1", text: "Tell me about planning." }]
    const study = await client.query("INSERT INTO research_studies (workspace_id,name,goal,guide,status) VALUES ($1,'Research results review',$2,$3,'CLOSED') RETURNING id", [workspace.rows[0].id, goal, JSON.stringify(guide)])
    studyId = study.rows[0].id
    const sessionIds: string[] = []
    const firstTurnOf: Record<string, string> = {}
    for (let i = 0; i < 21; i++) {
      const session = await client.query("INSERT INTO research_sessions (study_id,status,modality,completed_at,created_at) VALUES ($1,'COMPLETED',$2,now(),now() - $3::interval) RETURNING id", [studyId, i === 0 ? "VOICE" : "CHAT", `${i} minutes`])
      if (i === 0) sessionId = session.rows[0].id
      sessionIds.push(session.rows[0].id)
      for (let turn = 0; turn < (i === 0 ? 52 : 1); turn++) {
        const row = await client.query("INSERT INTO research_turns (session_id,role,content,sequence) VALUES ($1,'PARTICIPANT',$2,$3) RETURNING id", [session.rows[0].id, `Saved planning evidence ${i + 1}, turn ${turn + 1}.`, turn])
        if (turn === 0) firstTurnOf[session.rows[0].id] = row.rows[0].id
      }
    }
    // ADR-0012 step 6 retired POST /api/research/analysis {kind:"synthesis"},
    // which this test previously used to seed snapshots. Synthesis is now the
    // core agent's `generate_research_synthesis` tool, and driving a full agent
    // turn here would test the agent rather than the read surface these
    // assertions are about (history, evidence deep-links, layout, screenshots).
    // So the stored artifact is seeded directly, in the same shape and through
    // the same table that tool writes. The handoff BUTTON is still exercised
    // live at the end of this test.
    const quoteSession = sessionIds[0]
    const quoteTurn = firstTurnOf[quoteSession]
    const snapshot = JSON.stringify({
      version: 1, kind: "synthesis", generatedAt: new Date().toISOString(),
      sourceFingerprint: "a".repeat(64), sourceSessionIds: sessionIds,
      guideFingerprint: fingerprint(goal, guide), model: "claude-sonnet-5", promptVersion: "research-analysis-v1",
      summary: "Test synthesis from saved sessions.",
      themes: [{ title: "Saved participant evidence", description: "A fixture finding.", surprising: false, quotes: [{ sessionId: quoteSession, turnId: quoteTurn, text: "Saved planning evidence 1, turn 1." }] }],
      // Two sessions, matching the cross-session rule parseAnalysisResult enforces.
      patterns: [{ text: "Planning evidence recurs across sessions", evidenceTurnIds: [quoteTurn, firstTurnOf[sessionIds[1]]] }],
      jobs: [], recommendations: [],
    })
    // Two snapshots, so the history assertions below see a versioned list.
    for (const minutes of [2, 1]) await client.query("INSERT INTO research_syntheses (study_id,kind,content,session_count,model,prompt_version,created_at,updated_at) VALUES ($1,'CROSS_SESSION',$2,$3,'claude-sonnet-5','research-analysis-v1',now() - $4::interval,now())", [studyId, snapshot, sessionIds.length, `${minutes} minutes`])
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
  // ADR-0012 step 4: "Generate synthesis" hands off into a linked conversation,
  // matching PM Gather's Finish. Asserted last, because it navigates away.
  await page.goto(studyUrl)
  await page.setViewportSize({ width: 1280, height: 800 })
  const handoff = page.waitForResponse(response => response.url().endsWith("/api/research/synthesis-handoff") && response.request().method() === "POST")
  await page.getByRole("button", { name: "Regenerate synthesis", exact: true }).click()
  const handoffResponse = await handoff
  expect(handoffResponse.status(), await handoffResponse.text()).toBe(200)
  await expect(page).toHaveURL(new RegExp(`${base}/agent\\?c=[0-9a-f-]{36}$`))
  const denied = await page.goto(`/rbcodelabs/compass/capture/studies/${studyId}/sessions/${sessionId}`)
  expect(denied?.status()).toBe(404)
})
