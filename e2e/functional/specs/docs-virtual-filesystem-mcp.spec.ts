/**
 * ADR 0019 — Docs as a Virtual Filesystem. New user-facing MCP surface, so a
 * new functional spec is required (.claude/pr-guidelines.md's "new journeys
 * require new specs" rule) — this is the external-MCP-projection half of the
 * "Done looks like" checklist in docs/design/docs-virtual-filesystem-mcp.md §4:
 * resources/list enumerates every doc as a docs:// URI, resources/read returns
 * frontmatter + body, write_doc creates a doc at the right place in the tree
 * (verified against the DB and the page title, not just the tool's own
 * response), move_doc reparents it, and delete_doc without recursive on a doc
 * with children fails with the documented message.
 *
 * Follows the same real-MCP-client-over-HTTP pattern as
 * e2e/functional/specs/research-mcp.spec.ts: a synthetic, short-lived local
 * `cmp_` API key, never a configured credential.
 */
import { randomBytes, randomUUID, createHash } from "node:crypto"
import pg from "pg"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { test, expect } from "../fixtures/index"
import { assertIsolatedE2EDatabase } from "../fixtures/isolated-database"
import { E2E_USER_EMAIL } from "../fixtures/seed-e2e"

/** Every doc resource in this suite is text/markdown -- never a blob. */
function resourceText(content: { text?: string; blob?: string }): string {
  if (typeof content.text !== "string") throw new Error("Expected a text resource content, got a blob")
  return content.text
}

test("docs virtual filesystem MCP: write/read/move/history/comments/delete over resources + tools", async ({ page, base, baseURL }) => {
  test.setTimeout(180_000)
  await assertIsolatedE2EDatabase()
  expect(baseURL).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
  const schema = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev"
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Invalid local fixture schema")
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  let client: Client | undefined
  let apiKeyId: string | undefined
  const docIds: string[] = []
  const suffix = randomUUID().slice(0, 8)
  const rootTitle = `E2E VFS Root ${suffix}`
  const childTitle = `E2E VFS Child ${suffix}`
  const movedRootTitle = `E2E VFS Moved ${suffix}`

  try {
    const { rows: [scope] } = await pool.query<{ workspace_id: string; user_id: string }>(
      `SELECT w.id AS workspace_id, u.id AS user_id FROM "${schema}".workspaces w JOIN "${schema}".organizations o ON o.id=w.organization_id JOIN "${schema}".users u ON u.email=$1 WHERE o.slug='e2e-test-org' AND w.slug='e2e-workspace'`,
      [E2E_USER_EMAIL]
    )
    expect(scope).toBeTruthy()
    const workspaceId = scope.workspace_id

    const token = `cmp_${randomBytes(16).toString("hex")}`
    apiKeyId = randomUUID()
    await pool.query(
      `INSERT INTO "${schema}".api_keys (id,user_id,name,key_hash,key_prefix,purpose,expires_at) VALUES ($1,$2,'E2E docs VFS MCP',$3,$4,'USER',now()+interval '10 minutes')`,
      [apiKeyId, scope.user_id, createHash("sha256").update(token).digest("hex"), token.slice(4, 12)]
    )
    client = new Client({ name: "compass-docs-vfs-functional", version: "1.0.0" })
    await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", baseURL), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))

    async function callTool(name: string, args: Record<string, unknown>, successful = true) {
      const result = await client!.callTool({ name, arguments: args })
      const envelope = result.structuredContent as { ok: boolean; data: Record<string, unknown>; message: string } | undefined
      if (successful) {
        expect(result.isError, `MCP call ${name}: ${envelope?.message}`).not.toBe(true)
        expect(envelope?.ok, envelope?.message).toBe(true)
      } else {
        expect(result.isError === true || envelope?.ok === false).toBe(true)
      }
      return envelope?.data
    }

    // write_doc on a brand-new nested path creates BOTH the parent and the
    // child implicitly (spec §3.2's "parent directories created implicitly").
    const childPath = `${rootTitle}/${childTitle}`
    const created = await callTool("write_doc", {
      workspaceId,
      path: childPath,
      content: "---\nstatus: draft\n---\n\n# Child content\n",
    })
    const childDocId = String(created!.id)
    docIds.push(childDocId)
    expect(created!.created).toBe(true)
    const childRevision = String(created!.revision)

    const { rows: [rootRow] } = await pool.query<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id FROM "${schema}".docs WHERE workspace_id=$1 AND title=$2`,
      [workspaceId, rootTitle]
    )
    expect(rootRow).toBeTruthy()
    docIds.push(rootRow.id)
    expect(rootRow.parent_id).toBeNull()
    const { rows: [childRow] } = await pool.query<{ parent_id: string }>(
      `SELECT parent_id FROM "${schema}".docs WHERE id=$1`,
      [childDocId]
    )
    expect(childRow.parent_id).toBe(rootRow.id)

    // resources/list enumerates it as a docs:// URI; resources/read returns
    // frontmatter (compass_doc_id, compass_doc_type, the user's own `status`)
    // plus the body.
    const list = await client.listResources()
    const uri = list.resources.find(r => r.uri.includes(encodeURI(childPath)))?.uri
    expect(uri, JSON.stringify(list.resources.map(r => r.uri))).toBeTruthy()
    const read = await client.readResource({ uri: uri! })
    const text = resourceText(read.contents[0])
    expect(text).toContain(`compass_doc_id: ${childDocId}`)
    expect(text).toContain("compass_doc_type: STANDARD")
    expect(text).toContain("status: draft")
    expect(text).toContain("# Child content")

    // write_doc again at the SAME path updates rather than duplicating.
    const updated = await callTool("write_doc", {
      workspaceId,
      path: childPath,
      content: "# Updated child content\n",
      expectedRevision: childRevision,
    })
    expect(updated!.created).toBe(false)
    expect(updated!.id).toBe(childDocId)
    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM "${schema}".docs WHERE workspace_id=$1 AND title=$2`,
      [workspaceId, childTitle]
    )
    expect(Number(countRows[0].count)).toBe(1)

    // A stale expectedRevision is refused, not silently overwritten.
    await callTool("write_doc", { workspaceId, path: childPath, content: "clobber attempt", expectedRevision: childRevision }, false)

    // move_doc renames the root; the child's path (and DB parentId) follows.
    await callTool("move_doc", { workspaceId, fromPath: rootTitle, toPath: movedRootTitle })
    const { rows: [movedRow] } = await pool.query<{ title: string }>(`SELECT title FROM "${schema}".docs WHERE id=$1`, [rootRow.id])
    expect(movedRow.title).toBe(movedRootTitle)
    const listAfterMove = await client.listResources()
    expect(listAfterMove.resources.some(r => r.uri.includes(encodeURI(`${movedRootTitle}/${childTitle}`)))).toBe(true)

    // The doc is visible in the Compass UI at its real page, not just in the
    // tool's own response.
    await page.goto(`${base}/docs/${childDocId}`)
    await expect(page).toHaveTitle(new RegExp(`^${childTitle}\\b`))

    // list_doc_history / restore_doc_version round-trip. Every overwriting
    // write_doc auto-snapshots the doc's PRE-change state, coalesced to one
    // snapshot per 5-minute window per author -- this whole test runs inside
    // that window as the same MCP actor, so only the very first update's
    // snapshot (content = the doc's original "Child content" body) actually
    // gets saved; the second update's snapshot attempt is coalesced away.
    await callTool("write_doc", { workspaceId, path: `${movedRootTitle}/${childTitle}`, content: "# Third revision\n" })
    const history = await callTool("list_doc_history", { workspaceId, path: `${movedRootTitle}/${childTitle}` })
    expect((history!.items as unknown[]).length).toBe(1)
    const versionId = String((history!.items as Array<{ id: string }>)[0].id)
    await callTool("restore_doc_version", { workspaceId, path: `${movedRootTitle}/${childTitle}`, versionId })
    const restoredRead = await client.readResource({ uri: `docs://${workspaceId}/${encodeURI(`${movedRootTitle}/${childTitle}`)}` })
    expect(resourceText(restoredRead.contents[0])).toContain("# Child content")

    // add_doc_comment / list_doc_comments / resolve_doc_comment (path-addressed).
    const comment = await callTool("add_doc_comment", {
      workspaceId,
      path: `${movedRootTitle}/${childTitle}`,
      body: "Looks good",
      authorName: "E2E Reviewer",
    })
    const commentId = String(comment!.id)
    const comments = await callTool("list_doc_comments", { workspaceId, path: `${movedRootTitle}/${childTitle}` })
    expect((comments!.items as Array<{ id: string }>).some(c => c.id === commentId)).toBe(true)
    await callTool("resolve_doc_comment", { workspaceId, path: `${movedRootTitle}/${childTitle}`, commentId })
    const { rows: [commentRow] } = await pool.query<{ status: string }>(`SELECT status FROM "${schema}".doc_comments WHERE id=$1`, [commentId])
    expect(commentRow.status).toBe("RESOLVED")
    await callTool("resolve_doc_comment", { workspaceId, path: `${movedRootTitle}/${childTitle}`, commentId, resolved: false })
    const { rows: [reopenedRow] } = await pool.query<{ status: string }>(`SELECT status FROM "${schema}".doc_comments WHERE id=$1`, [commentId])
    expect(reopenedRow.status).toBe("OPEN")

    // delete_doc without recursive refuses a doc with children; recursive succeeds.
    await callTool("delete_doc", { workspaceId, path: movedRootTitle }, false)
    await callTool("delete_doc", { workspaceId, path: movedRootTitle, recursive: true })
    const { rows: remaining } = await pool.query<{ id: string }>(
      `SELECT id FROM "${schema}".docs WHERE id = ANY($1::uuid[])`,
      [[rootRow.id, childDocId]]
    )
    expect(remaining).toHaveLength(0)
  } finally {
    try { await client?.close() } finally {
      try {
        if (apiKeyId) await pool.query(`DELETE FROM "${schema}".api_keys WHERE id=$1`, [apiKeyId])
        if (docIds.length) {
          await pool.query(`DELETE FROM "${schema}".doc_comments WHERE doc_id = ANY($1::uuid[])`, [docIds])
          await pool.query(`DELETE FROM "${schema}".doc_versions WHERE doc_id = ANY($1::uuid[])`, [docIds])
          await pool.query(`DELETE FROM "${schema}".doc_operations WHERE doc_id = ANY($1::uuid[])`, [docIds])
          await pool.query(`DELETE FROM "${schema}".docs WHERE id = ANY($1::uuid[])`, [docIds])
        }
      } finally { await pool.end() }
    }
  }
})
