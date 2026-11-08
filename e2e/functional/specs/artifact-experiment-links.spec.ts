import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures/index"
import { execFileSync } from "node:child_process"
import getPrisma from "../../../lib/db"

// lib/artifacts.ts (and the entity_links reads behind it) load only under tsx, which resolves the repo's "@/" aliases.
const cli = (command: "read" | "delete" | "leftover", workspaceId: string, id: string): unknown =>
  JSON.parse(execFileSync("pnpm", ["exec", "tsx", "e2e/functional/fixtures/artifact-experiment-cli.ts", command, workspaceId, id], { encoding: "utf8", env: process.env }).trim().split("\n").at(-1)!)
const attachedArtifacts = (workspaceId: string, experimentId: string) => cli("read", workspaceId, experimentId)

/**
 * Artifacts <-> Experiments (native ARTIFACT_ATTACHED_TO_EXPERIMENT link). The whole flow goes through the real UI: link from the artifact
 * page, see it on the experiment page, unlink from the experiment side, relink, then delete the artifact and confirm the link is gone.
 */
async function chooseExisting(page: Page, noun: "experiment" | "artifact", title: string) {
  await page.getByRole("button", { name: `Link existing ${noun}`, exact: true }).click()
  const dialog = page.getByRole("dialog", { name: `Link existing ${noun}`, exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("combobox").click()
  const search = page.getByPlaceholder(`Search ${noun}s…`, { exact: true })
  await search.fill(title)
  // Wait for the debounced search to narrow the list to exactly this record before choosing, or Enter picks a stale first row.
  await expect(page.getByRole("option")).toHaveCount(1)
  await expect(page.getByRole("option").filter({ hasText: title })).toHaveCount(1)
  await search.press("ArrowDown")
  await search.press("Enter")
  await expect(dialog.getByRole("combobox")).toContainText(title)
  const submit = dialog.getByRole("button", { name: `Link ${noun}`, exact: true })
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(dialog).not.toBeVisible()
}

test("an artifact links to an experiment, shows on both pages, unlinks, and its link disappears when the artifact is deleted", async ({ page, base, workspaceSlug }, testInfo) => {
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } })
  const suffix = Date.now().toString(36)
  const experimentTitle = `Checkout prompt test ${suffix}`
  const artifactTitle = `Checkout prototype ${suffix}`
  const experiment = await prisma.experiment.create({ data: { workspaceId: workspace.id, title: experimentTitle, hypothesis: "A prompt increases completion.", method: "Prototype prompt", killCondition: "No increase", status: "DESIGNING" } })

  await page.goto(`${base}/docs/artifacts/new`)
  await page.getByLabel("Title").fill(artifactTitle)
  await page.getByLabel("Self-contained HTML file").setInputFiles({ name: "checkout.html", mimeType: "text/html", buffer: Buffer.from("<!doctype html><html><body><h1>Checkout</h1></body></html>") })
  await page.getByRole("button", { name: "Create artifact", exact: true }).click()
  await page.waitForURL(/\/docs\/artifacts\/[0-9a-f-]+$/)
  const artifactUrl = page.url()
  const artifactId = artifactUrl.split("/").at(-1)!

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
    await page.screenshot({ path: testInfo.outputPath(`artifact-experiments-${viewport.label}.png`), fullPage: true, animations: "disabled", style: "nextjs-portal { display: none }" })
  }
  await page.setViewportSize({ width: 1280, height: 800 })

  // It shows on the experiment page (full page), reached through the link.
  await experimentsSection.getByRole("link", { name: experimentTitle, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/experiments/${experiment.id}$`))
  const artifactsSection = page.getByRole("region", { name: "Linked artifacts" })
  await expect(artifactsSection.getByRole("link", { name: artifactTitle, exact: true })).toBeVisible()
  for (const viewport of [{ width: 1280, height: 800, label: "desktop" }, { width: 390, height: 844, label: "mobile" }]) {
    await page.setViewportSize(viewport)
    await artifactsSection.scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`experiment-artifacts-${viewport.label}.png`), fullPage: true, animations: "disabled", style: "nextjs-portal { display: none }" })
  }
  await page.setViewportSize({ width: 1280, height: 800 })

  // Unlink from the experiment side; both records survive.
  await artifactsSection.getByRole("button", { name: `Unlink ${artifactTitle}`, exact: true }).click()
  await expect(artifactsSection.getByText("No artifacts linked yet.")).toBeVisible()
  expect(attachedArtifacts(workspace.id, experiment.id)).toEqual([])
  expect(await prisma.artifact.count({ where: { id: artifactId } })).toBe(1)
  expect(await prisma.experiment.count({ where: { id: experiment.id } })).toBe(1)

  // Link again from the experiment side, then confirm the artifact page shows it.
  await chooseExisting(page, "artifact", artifactTitle)
  await expect(artifactsSection.getByRole("link", { name: artifactTitle, exact: true })).toBeVisible()
  await page.goto(artifactUrl)
  await expect(page.getByRole("region", { name: "Linked experiments" }).getByRole("link", { name: experimentTitle, exact: true })).toBeVisible()

  // Deleting the artifact removes the link and leaves the experiment.
  cli("delete", workspace.id, artifactId)
  // Nothing may still name the deleted artifact: deleteArtifact swept its link, so a second sweep finds zero rows.
  expect(cli("leftover", workspace.id, artifactId)).toBe(0)
  expect(attachedArtifacts(workspace.id, experiment.id)).toEqual([])
  await page.goto(`${base}/experiments/${experiment.id}`)
  await expect(page.getByRole("region", { name: "Linked artifacts" }).getByText("No artifacts linked yet.")).toBeVisible()
  await expect(page.getByRole("link", { name: artifactTitle, exact: true })).toHaveCount(0)
  expect(await prisma.experiment.count({ where: { id: experiment.id } })).toBe(1)
})
