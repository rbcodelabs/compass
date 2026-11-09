import type { Page, TestInfo } from "@playwright/test"
import { expect, test } from "../fixtures/index"
import { execFileSync } from "node:child_process"
import getPrisma from "../../../lib/db"

// lib/artifacts.ts (and the entity_links reads behind it) load only under tsx, which resolves the repo's "@/" aliases.
const cli = (command: "read" | "delete" | "leftover", workspaceId: string, id: string): unknown =>
  JSON.parse(execFileSync("pnpm", ["exec", "tsx", "e2e/functional/fixtures/artifact-experiment-cli.ts", command, workspaceId, id], { encoding: "utf8", env: process.env }).trim().split("\n").at(-1)!)
/** Full-page screenshot into the test output; also into ARTEXP_QA_DIR when set (the QA run keeps them). */
async function shoot(page: Page, testInfo: TestInfo, name: string) {
  const capture = { fullPage: true, animations: "disabled" as const, style: "nextjs-portal { display: none }" }
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), ...capture })
  if (process.env.ARTEXP_QA_DIR) await page.screenshot({ path: `${process.env.ARTEXP_QA_DIR}/${name}.png`, ...capture })
}
/**
 * Holds every server action (the section's link reads) until released, so the LOADING state can be seen and captured.
 * `visit` navigates; the screenshot is taken while the section still says "Loading links…".
 */
async function captureLoading(page: Page, testInfo: TestInfo, name: string, section: string, visit: () => Promise<void>) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/*", async (route) => {
    const request = route.request()
    if (request.method() === "POST" && request.headers()["next-action"]) await gate
    await route.continue()
  })
  try {
    await visit()
    await expect(page.getByRole("region", { name: section }).getByRole("status").filter({ hasText: "Loading links…" })).toBeVisible({ timeout: 60_000 })
    await page.getByRole("region", { name: section }).scrollIntoViewIfNeeded()
    await shoot(page, testInfo, name)
  } finally {
    release()
    // Let the held requests finish instead of aborting them when the route goes away.
    await page.unrouteAll({ behavior: "wait" })
  }
}
const attachedArtifacts = (workspaceId: string, experimentId: string) => cli("read", workspaceId, experimentId)

/**
 * Artifacts <-> Experiments (native ARTIFACT_ATTACHED_TO_EXPERIMENT link). The whole flow goes through the real UI: link from the artifact
 * page, see it on the experiment page, unlink from the experiment side, relink, then delete the artifact and confirm the link is gone.
 */
async function chooseExisting(page: Page, noun: "experiment" | "artifact", title: string, onPickerOpen?: () => Promise<void>) {
  await page.getByRole("button", { name: `Link existing ${noun}`, exact: true }).click()
  const dialog = page.getByRole("dialog", { name: `Link existing ${noun}`, exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("combobox").click()
  const search = page.getByPlaceholder(`Search ${noun}s…`, { exact: true })
  await search.fill(title)
  // Wait for the debounced search to narrow the list to exactly this record before choosing, or Enter picks a stale first row.
  await expect(page.getByRole("option")).toHaveCount(1)
  await expect(page.getByRole("option").filter({ hasText: title })).toHaveCount(1)
  await onPickerOpen?.()
  await search.press("ArrowDown")
  await search.press("Enter")
  await expect(dialog.getByRole("combobox")).toContainText(title)
  const submit = dialog.getByRole("button", { name: `Link ${noun}`, exact: true })
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(dialog).not.toBeVisible()
}

test("an artifact links to an experiment, shows on both pages, unlinks, and its link disappears when the artifact is deleted", async ({ page, base, workspaceSlug }, testInfo) => {
  // One long journey (two pages, archive, delete, 390px and 1280px captures, held loading states) on a dev server that compiles on demand.
  test.setTimeout(240_000)
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } })
  const suffix = Date.now().toString(36)
  // Long on purpose: the title must wrap on a 390px screen, not push the page sideways.
  const experimentTitle = `Checkout prompt test ${suffix} — does a contextual savings prompt on the payment step raise completion for first-time buyers without hurting average order value`
  const artifactTitle = `Checkout prototype ${suffix}`
  const experiment = await prisma.experiment.create({ data: { workspaceId: workspace.id, title: experimentTitle, hypothesis: "A prompt increases completion.", method: "Prototype prompt", killCondition: "No increase", status: "DESIGNING" } })

  await page.goto(`${base}/docs/artifacts/new`)
  await page.getByLabel("Title").fill(artifactTitle)
  await page.getByLabel("Self-contained HTML file").setInputFiles({ name: "checkout.html", mimeType: "text/html", buffer: Buffer.from("<!doctype html><html><body><h1>Checkout</h1></body></html>") })
  await page.getByRole("button", { name: "Create artifact", exact: true }).click()
  await page.waitForURL(/\/docs\/artifacts\/[0-9a-f-]+$/)
  const artifactUrl = page.url()
  const artifactId = artifactUrl.split("/").at(-1)!

  // Empty and loading states at 390px: the experiment panel (opened over the board) and the artifact page.
  await page.setViewportSize({ width: 390, height: 844 })
  const panelUrl = `${base}/experiments?detail=${encodeURIComponent(`experiment:${experiment.id}`)}`
  await captureLoading(page, testInfo, "experiment-panel-linked-artifacts-loading-mobile", "Linked artifacts", () => page.goto(panelUrl).then(() => undefined))
  const panelSection = page.getByRole("region", { name: "Linked artifacts" })
  await expect(panelSection.getByText("No artifacts linked yet.")).toBeVisible({ timeout: 60_000 })
  await panelSection.scrollIntoViewIfNeeded()
  await shoot(page, testInfo, "experiment-panel-linked-artifacts-empty-mobile")
  await captureLoading(page, testInfo, "artifact-linked-experiments-loading-mobile", "Linked experiments", () => page.goto(artifactUrl).then(() => undefined))
  await expect(page.getByRole("region", { name: "Linked experiments" }).getByText("No experiments linked yet.")).toBeVisible()
  await page.getByRole("region", { name: "Linked experiments" }).scrollIntoViewIfNeeded()
  await shoot(page, testInfo, "artifact-linked-experiments-empty-mobile")
  await page.setViewportSize({ width: 1280, height: 800 })

  // Link from the artifact page.
  const experimentsSection = page.getByRole("region", { name: "Linked experiments" })
  await expect(experimentsSection.getByText("No experiments linked yet.")).toBeVisible()
  await chooseExisting(page, "experiment", experimentTitle)
  await expect(experimentsSection.getByRole("link", { name: experimentTitle, exact: true })).toBeVisible()
  expect(attachedArtifacts(workspace.id, experiment.id)).toEqual([artifactId])

  for (const viewport of [{ width: 1280, height: 800, label: "desktop" }, { width: 390, height: 844, label: "mobile" }]) {
    await page.setViewportSize(viewport)
    await experimentsSection.scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await shoot(page, testInfo, `artifact-linked-experiments-${viewport.label}`)
  }
  await page.setViewportSize({ width: 1280, height: 800 })

  // It shows on the experiment page (full page), reached through the link.
  await experimentsSection.getByRole("link", { name: experimentTitle, exact: true }).click()
  // The route canonicalises a UUID to the experiment's EXP-n reference, and the first dev compile of this page is slow.
  await expect(page).toHaveURL(/\/experiments\/[^/?#]+$/, { timeout: 60_000 })
  const artifactsSection = page.getByRole("region", { name: "Linked artifacts" })
  await expect(artifactsSection.getByRole("link", { name: artifactTitle, exact: true })).toBeVisible()
  for (const viewport of [{ width: 1280, height: 800, label: "desktop" }, { width: 390, height: 844, label: "mobile" }]) {
    await page.setViewportSize(viewport)
    await artifactsSection.scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await shoot(page, testInfo, `experiment-linked-artifacts-${viewport.label}`)
  }
  await page.setViewportSize({ width: 1280, height: 800 })

  // Unlink from the experiment side; both records survive.
  await artifactsSection.getByRole("button", { name: `Unlink ${artifactTitle}`, exact: true }).click()
  await expect(artifactsSection.getByText("No artifacts linked yet.")).toBeVisible()
  expect(attachedArtifacts(workspace.id, experiment.id)).toEqual([])
  expect(await prisma.artifact.count({ where: { id: artifactId } })).toBe(1)
  expect(await prisma.experiment.count({ where: { id: experiment.id } })).toBe(1)

  // Link again from the experiment side, then confirm the artifact page shows it.
  // The relink runs on a 390px screen so the picker (dialog + combobox popup) is exercised and captured on mobile too.
  await page.setViewportSize({ width: 390, height: 844 })
  await chooseExisting(page, "artifact", artifactTitle, async () => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await shoot(page, testInfo, "experiment-link-picker-mobile")
  })
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(artifactsSection.getByRole("link", { name: artifactTitle, exact: true })).toBeVisible()
  await page.goto(artifactUrl)
  await expect(page.getByRole("region", { name: "Linked experiments" }).getByRole("link", { name: experimentTitle, exact: true })).toBeVisible({ timeout: 30_000 })

  // An archived artifact keeps its link visible and removable but cannot take a new one.
  await page.getByRole("button", { name: "Archive", exact: true }).click()
  await expect(page.getByText("This artifact is archived.")).toBeVisible()
  const archivedSection = page.getByRole("region", { name: "Linked experiments" })
  await expect(archivedSection.getByRole("link", { name: experimentTitle, exact: true })).toBeVisible()
  await expect(archivedSection.getByRole("button", { name: `Unlink ${experimentTitle}`, exact: true })).toBeEnabled()
  await expect(archivedSection.getByRole("button", { name: "Link existing experiment" })).toHaveCount(0)
  for (const viewport of [{ width: 1280, height: 800, label: "desktop" }, { width: 390, height: 844, label: "mobile" }]) {
    await page.setViewportSize(viewport)
    await archivedSection.scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await shoot(page, testInfo, `artifact-linked-experiments-archived-${viewport.label}`)
  }
  await page.setViewportSize({ width: 1280, height: 800 })

  // Deleting the artifact removes the link and leaves the experiment.
  cli("delete", workspace.id, artifactId)
  // Nothing may still name the deleted artifact: deleteArtifact swept its link, so a second sweep finds zero rows.
  expect(cli("leftover", workspace.id, artifactId)).toBe(0)
  expect(attachedArtifacts(workspace.id, experiment.id)).toEqual([])
  await page.goto(`${base}/experiments/${experiment.id}`)
  await expect(page.getByRole("region", { name: "Linked artifacts" }).getByText("No artifacts linked yet.")).toBeVisible({ timeout: 30_000 }) // the section loads through a server action; the dev server can be slow
  await expect(page.getByRole("link", { name: artifactTitle, exact: true })).toHaveCount(0)
  expect(await prisma.experiment.count({ where: { id: experiment.id } })).toBe(1)
})
