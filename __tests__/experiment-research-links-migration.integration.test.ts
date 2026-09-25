import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"
import { assertExperimentResearchStudyLinksMigration } from "@/lib/migrations/experiment-research-study-links"

const databaseUrl = process.env.EXPERIMENT_STUDY_MIGRATION_DATABASE_URL
describe.skipIf(!databaseUrl)("experiment-study migration in an owned local schema", () => {
  const schema = `experiment_study_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let created = false
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) throw new Error("Requires isolated local compass_e2e")
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
  })
  afterAll(async () => {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })
  it("runs the registered migration, enforces uniqueness, and reruns safely", async () => {
    const name = "060_experiment_research_study_links"
    const response = await applyMigrations(pool, schema, name)
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
    const client = await pool.connect()
    try { await assertExperimentResearchStudyLinksMigration(client, schema) } finally { client.release() }
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    await pool.query(`INSERT INTO "${schema}".experiment_research_study_links(workspace_id, experiment_id, study_id) VALUES ($1,$2,$3)`, ids)
    await expect(pool.query(`INSERT INTO "${schema}".experiment_research_study_links(workspace_id, experiment_id, study_id) VALUES ($1,$2,$3)`, ids)).rejects.toMatchObject({ code: "23505" })
    const rerun = await applyMigrations(pool, schema, name)
    expect(rerun.status, JSON.stringify(await rerun.clone().json())).toBe(200)
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".experiment_research_study_links`)).rows[0].count).toBe(1)
  })
})
