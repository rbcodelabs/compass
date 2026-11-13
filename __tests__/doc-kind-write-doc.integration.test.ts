/**
 * write_doc `kind`, the docs:// frontmatter and list_docs against a REAL Prisma client and a real Postgres schema with every registered
 * migration replayed (so docs.kind exists exactly as 117 creates it, and schema.prisma's mapping of it is exercised for real).
 *
 *   INTEGRATION_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5437/compass_e2e \
 *     pnpm exec vitest run __tests__/doc-kind-write-doc.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"

const holder = vi.hoisted(() => ({ client: null as unknown }))
vi.mock("@/lib/db", () => ({ default: () => holder.client }))
vi.mock("@/lib/following-hooks", () => ({ followAfterCreate: vi.fn(), mcpFollowActor: vi.fn() }))
vi.mock("@/lib/document-mcp-actor", () => ({ documentMcpActor: () => ({ authorId: null, authorName: "MCP Agent" }) }))

import { replayAllMigrations } from "./helpers/replay-migrations"
import { readPath } from "@/lib/doc-fs"
import { listLibraryDocs, writeDoc } from "@/lib/doc-fs-tool-handlers"
import { safeMatter } from "@/lib/safe-matter"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

const databaseUrl = integrationDatabaseUrl

describe.skipIf(!databaseUrl)("write_doc kind and list_docs against a real database", () => {
  const schema = `dkw_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const previous = process.env.DATABASE_URL
  const orgId = randomUUID()
  const workspaceId = randomUUID()
  let prisma: PrismaClient

  const kindOf = async (title: string) => (await pool.query<{ kind: string | null }>(`SELECT kind FROM "${schema}".docs WHERE workspace_id=$1 AND title=$2`, [workspaceId, title])).rows[0]?.kind
  const data = (result: Awaited<ReturnType<typeof writeDoc>>) => result.structuredContent.data as Record<string, unknown>

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires the local compass_e2e database")
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    const replay = await replayAllMigrations(pool, schema)
    expect(replay.status, JSON.stringify(await replay.json())).toBe(200)
    const { PrismaClient: Client } = await import("@prisma/client")
    const { PrismaPg } = await import("@prisma/adapter-pg")
    prisma = new Client({ adapter: new PrismaPg(pool, { schema }) })
    holder.client = prisma
    await pool.query(`INSERT INTO "${schema}".organizations (id, name, slug) VALUES ($1, 'Kind Org', 'kind-org')`, [orgId])
    await pool.query(`INSERT INTO "${schema}".workspaces (id, organization_id, name, slug) VALUES ($1, $2, 'Kind Workspace', 'kind-workspace')`, [workspaceId, orgId])
  }, 180_000)

  afterAll(async () => {
    try {
      await (prisma as PrismaClient | undefined)?.$disconnect()
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await pool.end()
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })

  it("creates with a kind, and without one (a missing kind is never an error)", async () => {
    const typed = await writeDoc({ workspaceId, path: "Decisions/ADR - Real", content: "body", kind: "ADR" })
    expect(typed.structuredContent.ok, typed.structuredContent.message).toBe(true)
    expect(await kindOf("ADR - Real")).toBe("ADR")
    expect(data(typed).kind).toBe("ADR")
    expect(await kindOf("Decisions")).toBeNull()

    const plain = await writeDoc({ workspaceId, path: "Plain note", content: "body" })
    expect(plain.structuredContent.ok).toBe(true)
    expect(await kindOf("Plain note")).toBeNull()
  })

  it("keeps the kind on an update that omits it, changes it, clears it, and saves a kind-only change", async () => {
    await writeDoc({ workspaceId, path: "Life cycle", content: "one", kind: "QA_REPORT" })
    await writeDoc({ workspaceId, path: "Life cycle", content: "two" })
    expect(await kindOf("Life cycle")).toBe("QA_REPORT")

    const before = (await pool.query<{ revision: string }>(`SELECT revision FROM "${schema}".docs WHERE workspace_id=$1 AND title='Life cycle'`, [workspaceId])).rows[0].revision
    const kindOnly = await writeDoc({ workspaceId, path: "Life cycle", content: "two", kind: "DESIGN" })
    expect(kindOnly.structuredContent.ok, kindOnly.structuredContent.message).toBe(true)
    expect(await kindOf("Life cycle")).toBe("DESIGN")
    expect((await pool.query<{ revision: string }>(`SELECT revision FROM "${schema}".docs WHERE workspace_id=$1 AND title='Life cycle'`, [workspaceId])).rows[0].revision).not.toBe(before)

    await writeDoc({ workspaceId, path: "Life cycle", content: "two", kind: null })
    expect(await kindOf("Life cycle")).toBeNull()
  })

  it("refuses an unknown kind before writing anything", async () => {
    const result = await writeDoc({ workspaceId, path: "Never made/Child", content: "body", kind: "SPEC" })
    expect(result.structuredContent.ok).toBe(false)
    const created = await pool.query(`SELECT 1 FROM "${schema}".docs WHERE workspace_id=$1 AND title IN ('Never made','Child')`, [workspaceId])
    expect(created.rows).toHaveLength(0)
  })

  it("reads compass_kind back in the docs:// frontmatter only when set, and ignores a spoofed one", async () => {
    await writeDoc({ workspaceId, path: "Frontmatter typed", content: "body", kind: "NOTE" })
    expect(safeMatter((await readPath(workspaceId, "Frontmatter typed"))!.content).data.compass_kind).toBe("NOTE")
    await writeDoc({ workspaceId, path: "Frontmatter untyped", content: "---\ncompass_kind: ADR\n---\nbody" })
    expect(await kindOf("Frontmatter untyped")).toBeNull()
    expect(Object.keys(safeMatter((await readPath(workspaceId, "Frontmatter untyped"))!.content).data)).not.toContain("compass_kind")
  })

  it("list_docs filters by kind, orders newest first and honours the limit", async () => {
    const stamp = async (title: string, iso: string) => pool.query(`UPDATE "${schema}".docs SET updated_at=$3 WHERE workspace_id=$1 AND title=$2`, [workspaceId, title, iso])
    for (const [path, kind] of [["Lists/ADR old", "ADR"], ["Lists/ADR new", "ADR"], ["Lists/Report", "QA_REPORT"], ["Lists/Loose", undefined]] as const) {
      await writeDoc({ workspaceId, path, content: "body", ...(kind ? { kind } : {}) })
    }
    await stamp("ADR old", "2031-01-01T00:00:00Z")
    await stamp("ADR new", "2031-02-01T00:00:00Z")
    await stamp("Report", "2031-03-01T00:00:00Z")

    const adrs = (await listLibraryDocs({ workspaceId, kind: "ADR" })).structuredContent.data as { items: { title: string; kind: string; path: string }[]; count: number }
    expect(adrs.items.map((item) => item.title).slice(0, 2)).toEqual(["ADR new", "ADR old"])
    expect(adrs.items.every((item) => item.kind === "ADR")).toBe(true)
    expect(adrs.items[0].path).toBe("Lists/ADR new")

    const everything = (await listLibraryDocs({ workspaceId, limit: 1 })).structuredContent.data as { items: { title: string }[]; total: number }
    expect(everything.items).toHaveLength(1)
    expect(everything.items[0].title).toBe("Report")
    expect(everything.total).toBeGreaterThan(1)

    const none = (await listLibraryDocs({ workspaceId, kind: "NOTE" })).structuredContent.data as { items: { title: string }[] }
    expect(none.items.map((item) => item.title)).toContain("Frontmatter typed")
    expect(none.items.map((item) => item.title)).not.toContain("Loose")
  })
})
