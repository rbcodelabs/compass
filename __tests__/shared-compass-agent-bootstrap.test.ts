import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { PoolClient } from "pg"
import {
  SHARED_COMPASS_AGENT_NAME,
  assertSharedCompassAgentBootstrap,
  bootstrapSharedCompassAgent,
  parseBootstrapWorkspaceIds,
  runSharedCompassAgentBootstrap,
} from "@/lib/migrations/shared-compass-agent-bootstrap"
import { assertReviewedManagedManifest, assertReviewedMigrationCode } from "@/lib/preview-automation/managed-manifest"
import { partitionPendingMigrations, selectMigrationsToRun } from "@/lib/migrations/runner"

const NAME = "103_shared_compass_agent_bootstrap"
const WS1 = "11111111-1111-4111-8111-111111111111"
const WS2 = "22222222-2222-4222-8222-222222222222"

type Db = {
  workspaces: string[]
  wsAdmins: Record<string, string>
  orgAdmins: Record<string, string>
  agents: { id: string; workspace: string; name: string }[]
  grants: { agentId: string; workspace: string; revokedAt: Date | null }[]
  defaults: { workspace: string; agentId: string }[]
  writes: string[]
  schemaColumns: { table_name: string; column_name: string; is_nullable: string }[]
}
const fullSchema = [
  ...["kind", "owner_type", "owner_workspace_id", "invoke_policy"].map((column_name) => ({ table_name: "agents", column_name, is_nullable: "YES" })),
  { table_name: "agents", column_name: "owner_user_id", is_nullable: "YES" },
  { table_name: "workspace_default_agents", column_name: "workspace_id", is_nullable: "NO" },
]
const newDb = (patch: Partial<Db> = {}): Db => ({ workspaces: [WS1, WS2], wsAdmins: { [WS1]: "admin-1", [WS2]: "admin-2" }, orgAdmins: {}, agents: [], grants: [], defaults: [], writes: [], schemaColumns: fullSchema, ...patch })

/** A tiny SQL-shape-aware fake: it answers by the statement's table and verb, which is what the hook's contract is about. */
function fakeClient(db: Db): PoolClient {
  let nextId = 1
  return {
    query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, " ")
      if (sql.includes("information_schema.columns")) return { rows: db.schemaColumns }
      if (sql.startsWith("SELECT count(*)") && sql.includes('"workspaces"')) return { rows: [{ n: String(db.workspaces.length) }] }
      if (sql.startsWith("SELECT 1") && sql.includes('"workspaces"')) return { rows: db.workspaces.includes(params[0] as string) ? [{}] : [] }
      if (sql.includes('"workspace_members"')) return { rows: db.wsAdmins[params[0] as string] ? [{ user_id: db.wsAdmins[params[0] as string] }] : [] }
      if (sql.includes('"organization_members"')) return { rows: db.orgAdmins[params[0] as string] ? [{ user_id: db.orgAdmins[params[0] as string] }] : [] }
      if (sql.startsWith('SELECT id FROM') && sql.includes('"agents"')) return { rows: db.agents.filter((a) => a.workspace === params[0] && a.name === params[1]).map((a) => ({ id: a.id })) }
      if (sql.startsWith('INSERT INTO') && sql.includes('"agents"')) {
        const id = `agent-${nextId++}`
        db.agents.push({ id, workspace: params[2] as string, name: params[0] as string })
        db.writes.push("agent")
        return { rows: [{ id }] }
      }
      if (sql.startsWith("SELECT revoked_at") && sql.includes('"agent_workspace_grants"')) return { rows: db.grants.filter((g) => g.agentId === params[0] && g.workspace === params[1]).map((g) => ({ revoked_at: g.revokedAt })) }
      if (sql.startsWith("SELECT 1") && sql.includes('"agent_workspace_grants"')) return { rows: db.grants.filter((g) => g.agentId === params[0] && g.workspace === params[1]).map(() => ({})) }
      if (sql.startsWith("INSERT INTO") && sql.includes('"agent_workspace_grants"')) {
        db.grants.push({ agentId: params[0] as string, workspace: params[1] as string, revokedAt: null })
        db.writes.push(`grant:${params[2]}`)
        return { rows: [] }
      }
      if (sql.startsWith("SELECT 1") && sql.includes('"workspace_default_agents"')) return { rows: db.defaults.filter((d) => d.workspace === params[0]).map(() => ({})) }
      if (sql.startsWith("INSERT INTO") && sql.includes('"workspace_default_agents"')) {
        db.defaults.push({ workspace: params[0] as string, agentId: params[1] as string })
        db.writes.push("default")
        return { rows: [] }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  } as unknown as PoolClient
}

describe(NAME, () => {
  it("is registered, explicit-only (an untargeted run skips it) and in the reviewed manifest with its hook digest", () => {
    expect(existsSync(path.join(process.cwd(), "prisma/migrations", NAME, "migration.sql"))).toBe(true)
    const entries = partitionPendingMigrations("compass_pr_1_aaaaaaaaaaaa", new Set()).pending
    expect(entries.map((e) => e.name)).toContain(NAME)
    expect(() => assertReviewedManagedManifest(entries)).not.toThrow()
    expect(() => assertReviewedMigrationCode(NAME)).not.toThrow()
    expect(() => assertReviewedMigrationCode(NAME, () => Buffer.from("tampered"))).toThrow(/digest changed/)
    expect(selectMigrationsToRun([{ name: NAME }, { name: "101_agent_default_selection" }]).map((m) => m.name)).toEqual(["101_agent_default_selection"])
    expect(selectMigrationsToRun([{ name: NAME }], NAME).map((m) => m.name)).toEqual([NAME])
  })

  it("contains no executable SQL (the work is the hook)", () => {
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations", NAME, "migration.sql"), "utf-8").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").trim()
    expect(sql).toBe("")
  })
})

describe("parseBootstrapWorkspaceIds", () => {
  it("refuses an empty list and malformed ids, de-duplicates and lower-cases", () => {
    expect(() => parseBootstrapWorkspaceIds(undefined)).toThrow(/name the workspaces/)
    expect(() => parseBootstrapWorkspaceIds(" , ")).toThrow(/name the workspaces/)
    expect(() => parseBootstrapWorkspaceIds("not-an-id")).toThrow(/not a workspace id/)
    expect(parseBootstrapWorkspaceIds(`${WS1.toUpperCase()}, ${WS1}`)).toEqual([WS1])
  })
})

describe("bootstrapSharedCompassAgent", () => {
  it("creates the agent, a WRITE grant issued by the workspace admin, and the default in each named workspace", async () => {
    const db = newDb()
    const log: string[] = []
    const outcomes = await bootstrapSharedCompassAgent(fakeClient(db), "s", log, [WS1])
    expect(outcomes).toEqual([expect.objectContaining({ workspaceId: WS1, createdAgent: true, createdGrant: true, setDefault: true })])
    expect(db.agents).toEqual([expect.objectContaining({ workspace: WS1, name: SHARED_COMPASS_AGENT_NAME })])
    expect(db.writes).toEqual(["agent", "grant:admin-1", "default"])
    expect(db.defaults).toEqual([{ workspace: WS1, agentId: db.agents[0].id }])
    // Only the named workspace is touched.
    expect(db.agents.some((a) => a.workspace === WS2)).toBe(false)
  })

  it("falls back to an organization admin when the workspace has no admin member", async () => {
    const db = newDb({ wsAdmins: {}, orgAdmins: { [WS1]: "org-admin" } })
    await bootstrapSharedCompassAgent(fakeClient(db), "s", [], [WS1])
    expect(db.writes).toContain("grant:org-admin")
  })

  it("is idempotent: a second run writes nothing", async () => {
    const db = newDb()
    await bootstrapSharedCompassAgent(fakeClient(db), "s", [], [WS1])
    db.writes.length = 0
    const outcomes = await bootstrapSharedCompassAgent(fakeClient(db), "s", [], [WS1])
    expect(db.writes).toEqual([])
    expect(outcomes[0]).toMatchObject({ createdAgent: false, createdGrant: false, setDefault: false })
    expect(db.agents).toHaveLength(1)
  })

  it("never overrides an existing workspace default", async () => {
    const db = newDb({ defaults: [{ workspace: WS1, agentId: "someone-elses-choice" }] })
    await bootstrapSharedCompassAgent(fakeClient(db), "s", [], [WS1])
    expect(db.defaults).toEqual([{ workspace: WS1, agentId: "someone-elses-choice" }])
  })

  it("does not revive a revoked grant, and does not make a revoked agent the default", async () => {
    const db = newDb({ agents: [{ id: "agent-old", workspace: WS1, name: SHARED_COMPASS_AGENT_NAME }], grants: [{ agentId: "agent-old", workspace: WS1, revokedAt: new Date() }] })
    const outcomes = await bootstrapSharedCompassAgent(fakeClient(db), "s", [], [WS1])
    expect(db.writes).toEqual([])
    expect(db.grants[0].revokedAt).not.toBeNull()
    expect(outcomes[0]).toMatchObject({ grantRevoked: true, setDefault: false })
  })

  it("writes nothing for any workspace when one named workspace is missing or has no administrator", async () => {
    const missing = newDb()
    await expect(bootstrapSharedCompassAgent(fakeClient(missing), "s", [], [WS1, "33333333-3333-4333-8333-333333333333"])).rejects.toThrow(/does not exist/)
    expect(missing.writes).toEqual([])
    const noAdmin = newDb({ wsAdmins: { [WS1]: "admin-1" } })
    await expect(bootstrapSharedCompassAgent(fakeClient(noAdmin), "s", [], [WS1, WS2])).rejects.toThrow(/no administrator/)
    expect(noAdmin.writes).toEqual([])
  })

  it("refuses to guess when a workspace already has two agents with the shared name", async () => {
    const db = newDb({ agents: [{ id: "a", workspace: WS1, name: SHARED_COMPASS_AGENT_NAME }, { id: "b", workspace: WS1, name: SHARED_COMPASS_AGENT_NAME }] })
    await expect(bootstrapSharedCompassAgent(fakeClient(db), "s", [], [WS1])).rejects.toThrow(/resolve that by hand/)
  })

  it.each([
    ["098 (cloud columns)", fullSchema.filter((c) => c.column_name !== "kind"), /migration 098/],
    ["099 (owner_user_id nullable)", fullSchema.map((c) => (c.column_name === "owner_user_id" ? { ...c, is_nullable: "NO" } : c)), /migration 099/],
    ["101 (default tables)", fullSchema.filter((c) => c.table_name !== "workspace_default_agents"), /migration 101/],
  ])("refuses until %s is applied", async (_label, schemaColumns, message) => {
    await expect(bootstrapSharedCompassAgent(fakeClient(newDb({ schemaColumns })), "s", [], [WS1])).rejects.toThrow(message)
  })
})

describe("runSharedCompassAgentBootstrap", () => {
  it("refuses a schema that has workspaces when none are named (never 'all workspaces')", async () => {
    const db = newDb()
    await expect(runSharedCompassAgentBootstrap(fakeClient(db), "s", [], {})).rejects.toThrow(/name the workspaces/)
    expect(db.writes).toEqual([])
  })

  it("is a no-op on a schema with no workspaces (a freshly provisioned preview)", async () => {
    const db = newDb({ workspaces: [] })
    const log: string[] = []
    await runSharedCompassAgentBootstrap(fakeClient(db), "s", log, {})
    expect(db.writes).toEqual([])
    expect(log.join("\n")).toMatch(/nothing to bootstrap/)
  })

  it("bootstraps the named workspaces and proves it", async () => {
    const db = newDb()
    await runSharedCompassAgentBootstrap(fakeClient(db), "s", [], { COMPASS_SHARED_AGENT_WORKSPACE_IDS: WS2 })
    expect(db.agents).toEqual([expect.objectContaining({ workspace: WS2 })])
  })
})

describe("assertSharedCompassAgentBootstrap", () => {
  it("fails with no agent, two agents, or no grant", async () => {
    await expect(assertSharedCompassAgentBootstrap(fakeClient(newDb()), "s", [WS1])).rejects.toThrow(/has 0/)
    const two = newDb({ agents: [{ id: "a", workspace: WS1, name: SHARED_COMPASS_AGENT_NAME }, { id: "b", workspace: WS1, name: SHARED_COMPASS_AGENT_NAME }] })
    await expect(assertSharedCompassAgentBootstrap(fakeClient(two), "s", [WS1])).rejects.toThrow(/has 2/)
    const noGrant = newDb({ agents: [{ id: "a", workspace: WS1, name: SHARED_COMPASS_AGENT_NAME }] })
    await expect(assertSharedCompassAgentBootstrap(fakeClient(noGrant), "s", [WS1])).rejects.toThrow(/no grant row/)
  })
})
