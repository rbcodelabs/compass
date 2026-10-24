/**
 * Every admin route that authenticates with a static secret must route the comparison through the
 * shared constant-time helper (lib/secret-compare.ts), reject a wrong secret with 401, and reject
 * when the configured secret is empty. Business behavior of each route is covered by its own test file;
 * these requests all fail authentication before touching any dependency.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/secret-compare", async () => {
  const actual = await vi.importActual<typeof import("@/lib/secret-compare")>("@/lib/secret-compare")
  return { secretMatches: vi.fn(actual.secretMatches) }
})
vi.mock("@/lib/db", () => ({ default: () => ({}) }))
vi.mock("@/lib/admin-dsql-pool", () => ({ withAdminDsqlClient: vi.fn() }))
vi.mock("@/lib/agent-snapshot-admin", () => ({
  getAgentSnapshotStatus: vi.fn(),
  rebuildAgentSnapshot: vi.fn(),
}))
vi.mock("@/lib/mcp-connectors/revoke-all", () => ({ revokeAllConnectorGrants: vi.fn() }))

import { secretMatches } from "@/lib/secret-compare"
import { POST as normalizeMemberRoles } from "@/app/api/admin/normalize-member-roles/route"
import { POST as portalSsoResync } from "@/app/api/admin/portal-sso-resync/route"
import { POST as purgeFeedback } from "@/app/api/admin/purge-feedback/route"
import {
  GET as rebuildSnapshotGet,
  POST as rebuildSnapshotPost,
} from "@/app/api/admin/rebuild-agent-snapshot/route"
import { POST as sharedCommentsBackfill } from "@/app/api/admin/shared-comments-backfill/route"
import { GET as workspacesGet, POST as workspacesPost } from "@/app/api/admin/workspaces/route"
import { POST as revokeConnectorGrants } from "@/app/api/admin/revoke-connector-grants/route"
import { POST as repairWorkspaceMemberships } from "@/app/api/admin/repair-workspace-memberships/route"

const CONFIGURED = "configured-secret-value"
const ORIGINAL_ENV = { ...process.env }

function headerRequest(secret: string | null): NextRequest {
  return new NextRequest("http://localhost/api/admin/x", {
    method: "POST",
    body: JSON.stringify({}),
    headers: {
      "Content-Type": "application/json",
      ...(secret === null ? {} : { "x-migration-secret": secret }),
    },
  })
}

const headerRoutes: Array<[string, (req: NextRequest) => Promise<Response> | Response]> = [
  ["normalize-member-roles POST", normalizeMemberRoles],
  ["portal-sso-resync POST", portalSsoResync],
  ["purge-feedback POST", purgeFeedback],
  ["rebuild-agent-snapshot GET", rebuildSnapshotGet],
  ["rebuild-agent-snapshot POST", rebuildSnapshotPost],
  ["shared-comments-backfill POST", sharedCommentsBackfill],
  ["workspaces GET", workspacesGet],
  ["workspaces POST", workspacesPost],
  ["revoke-connector-grants POST", revokeConnectorGrants],
]

beforeEach(() => {
  vi.mocked(secretMatches).mockClear()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe.each(headerRoutes)("%s secret check", (_name, handler) => {
  it("rejects a wrong secret with 401, via the shared constant-time helper", async () => {
    process.env.MIGRATION_SECRET = CONFIGURED
    const res = await handler(headerRequest("not-the-secret"))
    expect(res.status).toBe(401)
    expect(secretMatches).toHaveBeenCalledWith("not-the-secret", CONFIGURED)
  })

  it("rejects when the configured secret is empty, even with an empty header", async () => {
    process.env.MIGRATION_SECRET = ""
    const res = await handler(headerRequest(""))
    expect(res.status).toBe(401)
    expect(secretMatches).toHaveBeenCalled()
  })

  it("rejects when the header is absent", async () => {
    process.env.MIGRATION_SECRET = CONFIGURED
    const res = await handler(headerRequest(null))
    expect(res.status).toBe(401)
  })
})

describe("repair-workspace-memberships secret check (body field vs REPAIR_SECRET)", () => {
  function bodyRequest(secret: string): NextRequest {
    return new NextRequest("http://localhost/api/admin/repair-workspace-memberships", {
      method: "POST",
      body: JSON.stringify({ secret, orgSlug: "acme" }),
      headers: { "Content-Type": "application/json" },
    })
  }

  it("rejects a wrong secret with 401, via the shared constant-time helper", async () => {
    process.env.REPAIR_SECRET = CONFIGURED
    const res = await repairWorkspaceMemberships(bodyRequest("not-the-secret"))
    expect(res.status).toBe(401)
    expect(secretMatches).toHaveBeenCalledWith("not-the-secret", CONFIGURED)
  })

  it("rejects when the configured secret is empty, even with an empty body secret", async () => {
    process.env.REPAIR_SECRET = ""
    const res = await repairWorkspaceMemberships(bodyRequest(""))
    expect([401, 500]).toContain(res.status)
  })
})
