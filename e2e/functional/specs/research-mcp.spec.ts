import { randomBytes, randomUUID, createHash } from "node:crypto"
import pg from "pg"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { test, expect } from "../fixtures/index"
import { assertIsolatedE2EDatabase } from "../fixtures/isolated-database"
import { E2E_USER_EMAIL } from "../fixtures/seed-e2e"

test("research MCP: member authoring, bounded metadata, link races and tenant denial", async ({ page, base, baseURL }) => {
  test.setTimeout(180_000)
  await assertIsolatedE2EDatabase()
  expect(baseURL).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
  const schema = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev"
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Invalid local fixture schema")
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const clients: Client[] = []
  const keyIds: string[] = []
  let sequence = 0
  try {
    const { rows: [scope] } = await pool.query<{ workspace_id: string; organization_id: string; user_id: string }>(`SELECT w.id AS workspace_id, w.organization_id, u.id AS user_id FROM "${schema}".workspaces w JOIN "${schema}".organizations o ON o.id=w.organization_id JOIN "${schema}".users u ON u.email=$1 WHERE o.slug='e2e-test-org' AND w.slug='e2e-workspace'`, [E2E_USER_EMAIL])
    expect(scope).toBeTruthy()
    async function connect(purpose: "USER" | "RESEARCH") {
      // Synthetic, short-lived local keys only. Never read a configured MCP credential.
      const token = `cmp_${randomBytes(16).toString("hex")}`
      const id = randomUUID()
      keyIds.push(id)
      await pool.query(`INSERT INTO "${schema}".api_keys (id,user_id,name,key_hash,key_prefix,purpose,scope_workspace_id,expires_at) VALUES ($1,$2,'E2E research MCP',$3,$4,$5,$6,now()+interval '10 minutes')`, [id, scope.user_id, createHash("sha256").update(token).digest("hex"), token.slice(4, 12), purpose, scope.workspace_id])
      const client = new Client({ name: "compass-research-functional", version: "1.0.0" })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", baseURL), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
      return client
    }
    const member = await connect("USER")
    const research = await connect("RESEARCH")
    async function call(name: string, args: Record<string, unknown>, successful = true) {
      const result = await member.callTool({ name, arguments: { workspaceId: scope.workspace_id, ...args } })
      const envelope = result.structuredContent as { ok: boolean; data: Record<string, unknown>; message: string } | undefined
      if (successful) {
        expect(result.isError, `MCP call ${++sequence}: ${name}`).not.toBe(true)
        expect(envelope?.ok, envelope?.message).toBe(true)
      } else expect(result.isError === true || envelope?.ok === false).toBe(true)
      return envelope?.data
    }
    // A caller-provided reviewed guide exercises authoring without invoking a paid model.
    const create = { name: "E2E MCP interview", goal: "Understand planning", guide: ["Tell me about the last time you planned your work."], studyType: "CUSTOMER_INTERVIEW", targetMinutes: 15 }
    const first = await call("create_research_study", create)
    const studyId = String(first!.id)
    const originalLink = String(first!.participantUrl)
    expect(originalLink).toContain("/research/")
    await call("create_research_study", { ...create, name: "E2E MCP guided", studyType: "USABILITY_TEST", appUrl: "https://example.com/product", guide: ["Find information that helps you choose a plan."] })
    const listing = await call("list_research_studies", { limit: 1 })
    expect(listing!.items).toHaveLength(1)
    expect(listing!.nextCursor).toEqual(expect.any(String))
    const next = await call("list_research_studies", { limit: 1, cursor: listing!.nextCursor })
    expect(next!.items).toHaveLength(1)
    expect((next!.items as Array<{ id: string }>)[0].id).not.toBe((listing!.items as Array<{ id: string }>)[0].id)
    const metadata = await call("get_research_study", { studyId })
    expect(metadata!.name).toBe(create.name)
    for (const key of ["shareTokenHash", "participantTokens", "tokenHash", "sessions", "attachments", "participantUrl"]) expect(metadata).not.toHaveProperty(key)
    await call("update_research_study", { studyId, name: "E2E MCP renamed" })
    const renamed = await call("get_research_study", { studyId })
    expect(renamed).toMatchObject({ name: "E2E MCP renamed", goal: create.goal, targetMinutes: 15 })
    await page.goto(`${base}/capture/studies/${studyId}`)
    await expect(page.getByRole("heading", { name: "E2E MCP renamed", exact: true })).toBeVisible()
    await pool.query(`INSERT INTO "${schema}".research_sessions (study_id,status,modality) VALUES ($1,'COMPLETED','CHAT')`, [studyId])
    await call("update_research_study", { studyId, name: "E2E MCP locked", goal: "Must not overwrite the interview protocol" })
    expect(await call("get_research_study", { studyId })).toMatchObject({ name: "E2E MCP locked", goal: create.goal, sessionCount: 1 })

    await call("issue_research_link", { studyId }, false)
    await call("revoke_research_links", { studyId })
    const concurrent = await Promise.all([1, 2].map(() => member.callTool({ name: "issue_research_link", arguments: { workspaceId: scope.workspace_id, studyId } })))
    expect(concurrent.filter(result => (result.structuredContent as { ok?: boolean } | undefined)?.ok === true)).toHaveLength(1)
    const { rows: [links] } = await pool.query<{ count: string }>(`SELECT count(*) FROM "${schema}".research_participant_tokens WHERE study_id=$1 AND kind='PRIMARY' AND revoked_at IS NULL AND expires_at>now()`, [studyId])
    expect(Number(links.count)).toBe(1)
    const rotated = await call("rotate_research_link", { studyId })
    expect(rotated!.participantUrl).not.toBe(originalLink)
    await call("close_research_study", { studyId })
    expect(await call("get_research_study", { studyId })).toMatchObject({ status: "CLOSED" })
    const activated = await call("activate_research_study", { studyId })
    expect(activated!.participantUrl).not.toBe(rotated!.participantUrl)
    await call("archive_research_study", { studyId })
    expect(await call("get_research_study", { studyId })).toMatchObject({ status: "ARCHIVED" })
    const archived = await call("list_research_studies", { status: "ARCHIVED" })
    expect((archived!.items as Array<{ id: string }>).some(item => item.id === studyId)).toBe(true)

    const foreignId = randomUUID()
    await pool.query(`INSERT INTO "${schema}".workspaces (id,organization_id,slug,name) VALUES ($1,$2,$3,'E2E MCP no membership')`, [foreignId, scope.organization_id, `mcp-denied-${foreignId}`])
    await call("get_research_study", { studyId, workspaceId: foreignId }, false)
    await call("create_research_study", { ...create, workspaceId: foreignId }, false)
    for (const name of ["list_research_studies", "create_research_study"]) {
      const denied = await research.callTool({ name, arguments: { workspaceId: scope.workspace_id, ...create } })
      expect(denied.isError).toBe(true)
    }
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    try { if (keyIds.length) await pool.query(`DELETE FROM "${schema}".api_keys WHERE id=ANY($1::uuid[]) AND name='E2E research MCP'`, [keyIds]) }
    finally { await pool.end() }
  }
})
