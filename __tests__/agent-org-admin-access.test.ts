import { describe, expect, it, vi } from "vitest"
import type getPrisma from "@/lib/db"
import { listAgentAccessRows } from "@/lib/agent-org-admin-access"

function prismaWith(opts: { members: { userId: string; role: string }[]; agents: { id: string; name: string; ownerUserId: string }[]; grants: { agentId: string; grantedByUserId: string }[] }) {
  const agentFindMany = vi.fn().mockResolvedValue(opts.agents)
  const prisma = {
    organizationMember: { findMany: vi.fn().mockResolvedValue(opts.members) },
    agent: { findMany: agentFindMany },
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

  it("queries only ACTIVE agents owned by current members", async () => {
    const { prisma, agentFindMany } = prismaWith({ members, agents: [], grants: [] })
    expect(await listAgentAccessRows(prisma, "org-1")).toEqual([])
    expect(agentFindMany.mock.calls[0][0].where).toEqual({ status: "ACTIVE", ownerUserId: { in: ["owner", "admin", "demoted"] } })
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
})
