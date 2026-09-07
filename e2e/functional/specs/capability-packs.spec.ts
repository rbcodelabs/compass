import { test, expect } from "../fixtures/index"
import pg from "pg"
import { randomUUID } from "node:crypto"
import path from "node:path"

// Only local, dedicated test data. External installation is opt-in because it
// exercises GitHub availability/rate limits; configuration runs in every suite.
const source = process.env.E2E_CAPABILITY_PACK_REPOSITORY
const commit = process.env.E2E_CAPABILITY_PACK_COMMIT
let pool: pg.Pool
let workspaceId: string
let oldVersion: string
let newVersion: string

test.beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!)
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Capability pack tests require local compass_e2e")
  pool = new pg.Pool({ connectionString: url.toString() })
  const result = await pool.query(`SELECT w.id FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON o.id=w.organization_id WHERE o.slug='e2e-test-org' AND w.slug='e2e-workspace'`)
  workspaceId = result.rows[0].id
})

async function clearPacks() {
  await pool.query(`DELETE FROM compass_dev.workspace_capability_packs WHERE workspace_id=$1`, [workspaceId])
  await pool.query(`DELETE FROM compass_dev.capability_pack_versions WHERE capability_pack_id IN (SELECT id FROM compass_dev.capability_packs WHERE workspace_id=$1)`, [workspaceId])
  await pool.query(`DELETE FROM compass_dev.capability_packs WHERE workspace_id=$1`, [workspaceId])
}

test.beforeEach(async () => {
  await clearPacks()
  const packId = randomUUID()
  oldVersion = randomUUID()
  newVersion = randomUUID()
  await pool.query(`INSERT INTO compass_dev.capability_packs (id,workspace_id,pack_id,source_key,display_name,created_at,updated_at) VALUES ($1,$2,'sample-product-skills',$3,'Sample Product Skills',NOW(),NOW())`, [packId, workspaceId, "c".repeat(64)])
  for (const [id, version, sha, enabledByDefault] of [[oldVersion, "1.0.0", "a", false], [newVersion, "1.1.0", "b", true]] as const) {
    const manifest = { schemaVersion: 1, id: "sample-product-skills", displayName: "Sample Product Skills", version, sdkCompatibility: ">=0.3.224 <0.4.0", requiredHostCapabilities: ["compass.product_state"], enabledSkills: ["discovery"], skills: [{ id: "discovery", path: "skills/discovery/SKILL.md", enabledByDefault: true }, { id: "status-report", path: "skills/status-report/SKILL.md", enabledByDefault }] }
    await pool.query(`INSERT INTO compass_dev.capability_pack_versions (id,capability_pack_id,semantic_version,source_repository,source_commit,source_path,artifact_sha256,artifact_pathname,sdk_compatibility,manifest_json,validation_status,created_by_id,created_at) VALUES ($1,$2,$3,'https://github.com/example/product-skills',$4,'packs/product',$5,$6,$7,$8,'VALID',(SELECT id FROM compass_dev.users WHERE email='dev@localhost.dev'),NOW())`, [id, packId, version, sha.repeat(40), sha.repeat(64), `capability-packs/e2e/${id}.json`, manifest.sdkCompatibility, JSON.stringify(manifest)])
  }
  await pool.query(`INSERT INTO compass_dev.workspace_capability_packs (id,workspace_id,capability_pack_id,capability_pack_version_id,enabled_skill_ids,enabled,created_at,updated_at) VALUES ($1,$2,$3,$4,'["discovery"]',true,NOW(),NOW())`, [randomUUID(), workspaceId, packId, newVersion])
})
test.afterEach(async () => { await clearPacks() })
test.afterAll(async () => { await pool?.end() })

test("persists skill selection, disable/enable, and rollback through real settings actions", async ({ page, base }) => {
  await page.goto(`${base}/settings`)
  const skill = page.getByRole("checkbox", { name: "status-report", exact: true })
  await skill.focus()
  await expect(skill).toBeFocused()
  await page.keyboard.press("Space")
  await expect.poll(async () => (await pool.query(`SELECT enabled_skill_ids FROM compass_dev.workspace_capability_packs WHERE workspace_id=$1`, [workspaceId])).rows[0].enabled_skill_ids).toBe('["discovery","status-report"]')
  await page.reload()
  await expect(skill).toBeChecked()
  await page.getByRole("button", { name: "Disable", exact: true }).click()
  await expect(page.getByRole("button", { name: "Enable", exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: "Enable", exact: true }).click()
  await expect(page.getByRole("button", { name: "Disable", exact: true })).toBeVisible()
  await page.getByRole("combobox", { name: "Version", exact: true }).selectOption(oldVersion)
  await expect(skill).not.toBeChecked()
  await page.reload()
  await expect(page.getByRole("combobox", { name: "Version", exact: true })).toHaveValue(oldVersion)
  await expect(skill).not.toBeChecked()
  await expect(page.getByRole("checkbox", { name: "discovery", exact: true })).toBeChecked()
})

test("rejects an invalid install without changing installed configuration", async ({ page, base }) => {
  await page.goto(`${base}/settings`)
  await page.getByRole("textbox", { name: "GitHub repository URL" }).fill("https://github.com/example/product-skills")
  await page.getByRole("textbox", { name: "Full commit SHA" }).fill("main")
  await page.getByRole("button", { name: "Install and enable" }).click()
  await expect(page.getByRole("alert").filter({ hasText: /commit|SHA/i })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Version", exact: true })).toHaveValue(newVersion)
  expect((await pool.query(`SELECT count(*) FROM compass_dev.capability_packs WHERE workspace_id=$1`, [workspaceId])).rows[0].count).toBe("1")
})

for (const viewport of [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }]) {
  test(`${viewport.name} settings shows configured skills with usable navigation`, async ({ page, base }) => {
    await page.setViewportSize(viewport)
    await page.goto(`${base}/settings`)
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible()
    await expect(page.getByRole("navigation", { name: viewport.name === "mobile" ? "Primary navigation" : "Main navigation", exact: true })).toBeVisible()
    await expect(page.getByRole("navigation", { name: viewport.name === "mobile" ? "Main navigation" : "Primary navigation", exact: true })).toBeHidden()
    const heading = page.getByRole("heading", { name: "Agent capability packs" })
    await heading.scrollIntoViewIfNeeded()
    await expect(page.getByRole("checkbox", { name: "discovery", exact: true })).toBeChecked()
    await page.getByRole("combobox", { name: "Version", exact: true }).scrollIntoViewIfNeeded()
    await page.getByRole("checkbox", { name: "status-report", exact: true }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    if (process.env.UPDATE_CAPABILITY_PACK_SCREENSHOTS === "1") {
      await page.screenshot({ path: path.join("public/screenshots/docs", `capability-packs-${viewport.name}.png`), animations: "disabled" })
    }
  })
}

test("installs a public GitHub pack at its immutable commit", async ({ page, base }) => {
  test.skip(!source || !commit, "Set E2E_CAPABILITY_PACK_REPOSITORY and E2E_CAPABILITY_PACK_COMMIT to verify public GitHub installation")
  test.setTimeout(180_000)
  await clearPacks()
  await page.goto(`${base}/settings`)
  await expect(page.getByText("No capability packs installed.")).toBeVisible()
  await page.getByRole("textbox", { name: "GitHub repository URL" }).fill(source!)
  await page.getByRole("textbox", { name: "Full commit SHA" }).fill(commit!)
  await page.getByRole("textbox", { name: "Pack path" }).fill(process.env.E2E_CAPABILITY_PACK_PATH ?? "packs/compass")
  await page.getByRole("button", { name: "Install and enable" }).click()
  await expect(page.getByRole("button", { name: "Disable", exact: true })).toBeVisible({ timeout: 150_000 })
  const result = await pool.query(`SELECT v.source_commit,v.artifact_sha256,a.enabled FROM compass_dev.workspace_capability_packs a JOIN compass_dev.capability_pack_versions v ON v.id=a.capability_pack_version_id WHERE a.workspace_id=$1`, [workspaceId])
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0]).toMatchObject({ source_commit: commit, enabled: true })
  expect(result.rows[0].artifact_sha256).toMatch(/^[0-9a-f]{64}$/)
  await page.reload()
  await expect(page.getByRole("button", { name: "Disable", exact: true })).toBeVisible()
})
