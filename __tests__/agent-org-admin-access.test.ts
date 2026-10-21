import { describe, expect, it, vi } from "vitest"
import type getPrisma from "@/lib/db"
import { listAgentAccessRows } from "@/lib/agent-org-admin-access"

function prismaWith(opts: { members: { userId: string; role: string }[]; agents: { id: string; name: string; ownerUserId: string | null; ownerType?: string; ownerWorkspaceId?: string }[]; grants: { agentId: string; grantedByUserId: string }[] }) {
  const agentFindMany = vi.fn().mockResolvedValue(opts.agents)
  const prisma = {
    organizationMember: { findMany: vi.fn().mockResolvedValue(opts.members) },
    agent: { findMany: agentFindMany },
    workspace: { findMany: vi.fn().mockResolvedValue([{ id: "ws-1", name: "Platform" }]) },
    agentOrgAdminGrant: { findMany: vi.fn().mockResolvedValue(opts.grants) },
    user: {
      findMany: vi.fn().mockResolvedValue([
        { id: "owner", name: "Olive", email: "o@x.com" },
        { id: "admin", name: null, email: "admin@x.com" },
        { id: "demoted", name: "Dee", email: "d@x.com" },
      ]),
    },
  } as unknown as ReturnType<typeof getPrisma>
  return { prisma, agentFindMany }
}

describe("listAgentAccessRows", () => {
  const members = [
    { userId: "owner", role: "MEMBER" },
    { userId: "admin", role: "owner" },
    { userId: "demoted", role: "MEMBER" },
  ]

  it("queries only ACTIVE agents owned by current members or this org's workspaces", async () => {
    const { prisma, agentFindMany } = prismaWith({ members, agents: [], grants: [] })
    expect(await listAgentAccessRows(prisma, "org-1")).toEqual([])
    expect(agentFindMany.mock.calls[0][0].where).toEqual({ status: "ACTIVE", OR: [{ ownerUserId: { in: ["owner", "admin", "demoted"] } }, { ownerWorkspaceId: { in: ["ws-1"] } }] })
  })

  it("reports ungranted, active-granted and inactive-grantor states", async () => {
    const { prisma } = prismaWith({
      members,
      agents: [
        { id: "a1", name: "A", ownerUserId: "owner" },
        { id: "a2", name: "B", ownerUserId: "owner" },
        { id: "a3", name: "C", ownerUserId: "owner" },
      ],
      grants: [
        { agentId: "a2", grantedByUserId: "admin" },
        { agentId: "a3", grantedByUserId: "demoted" },
      ],
    })
    const rows = await listAgentAccessRows(prisma, "org-1")
    expect(rows[0]).toMatchObject({ agentId: "a1", ownerName: "Olive", granted: false, inactive: false })
    expect(rows[1]).toMatchObject({ agentId: "a2", granted: true, grantedByName: "admin@x.com", inactive: false })
    expect(rows[2]).toMatchObject({ agentId: "a3", granted: true, grantedByName: "Dee", inactive: true })
  })

  it("lists a WORKSPACE-owned agent under its workspace, and still marks its grant inactive when the grantor lost admin", async () => {
    const { prisma } = prismaWith({
      members,
      agents: [
        { id: "s1", name: "Shared", ownerUserId: null, ownerType: "WORKSPACE", ownerWorkspaceId: "ws-1" },
        // Owned by a workspace outside this org: must not be listed even if the query returned it.
        { id: "s2", name: "Foreign", ownerUserId: null, ownerType: "WORKSPACE", ownerWorkspaceId: "ws-other" },
      ],
      grants: [{ agentId: "s1", grantedByUserId: "demoted" }],
    })
    const rows = await listAgentAccessRows(prisma, "org-1")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agentId: "s1", ownerName: "Platform", granted: true, inactive: true })
  })
})
