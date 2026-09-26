import getPrisma from "@/lib/db"

export type ConnectedAppWorkspace = {
  workspaceName: string
  organizationName: string
  access: "READ" | "WRITE" | "FULL"
}

export type ConnectedApp = {
  id: string
  clientName: string
  redirectHosts: string[]
  binding: { mode: "AGENT" | "USER"; agentName: string | null }
  scopes: string[]
  workspaces: ConnectedAppWorkspace[]
  grantedAt: Date
  lastUsedAt: Date | null
}

type ConsentInput = {
  id: string
  clientId: string
  scope: string
  authorizationMode: string | null
  agentId: string | null
  grantedAt: Date
}

type ClientInput = {
  clientId: string
  clientName: string
  redirectUris: unknown
}

type BuildConnectedAppsInput = {
  consents: readonly ConsentInput[]
  clients: readonly ClientInput[]
  tokens: ReadonlyArray<{ clientId: string; lastUsedAt: Date | null }>
  agents: ReadonlyArray<{ id: string; name: string }>
  grants: ReadonlyArray<{ agentId: string; workspaceId: string; access: string }>
  memberWorkspaces: ReadonlyMap<string, { workspaceName: string; organizationName: string }>
}

function redirectHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return ["Unknown host"]
  const hosts = new Set<string>()
  for (const item of value) {
    if (typeof item !== "string") continue
    try {
      hosts.add(new URL(item).host)
    } catch {
      hosts.add("Unknown host")
    }
  }
  return hosts.size > 0 ? [...hosts] : ["Unknown host"]
}

function splitScopes(scope: string): string[] {
  return [...new Set(scope.split(/\s+/).filter(Boolean))]
}

function newestUse(
  tokens: ReadonlyArray<{ clientId: string; lastUsedAt: Date | null }>,
  clientId: string,
): Date | null {
  let newest: Date | null = null
  for (const token of tokens) {
    if (token.clientId !== clientId || !token.lastUsedAt) continue
    if (!newest || token.lastUsedAt > newest) newest = token.lastUsedAt
  }
  return newest
}

export function buildConnectedApps(input: BuildConnectedAppsInput): ConnectedApp[] {
  const clients = new Map(input.clients.map((client) => [client.clientId, client]))
  const agents = new Map(input.agents.map((agent) => [agent.id, agent]))
  const collator = new Intl.Collator("en")

  return input.consents.flatMap((consent): ConnectedApp[] => {
    const client = clients.get(consent.clientId)
    // A dangling consent cannot state which app receives access. Omitting it
    // is safer than presenting an actionable row with invented client data.
    if (!client) return []
    if (consent.authorizationMode !== "AGENT" && consent.authorizationMode !== "USER") return []

    let binding: ConnectedApp["binding"]
    let workspaces: ConnectedAppWorkspace[]
    if (consent.authorizationMode === "USER") {
      binding = { mode: "USER", agentName: null }
      workspaces = [...input.memberWorkspaces.values()].map((workspace) => ({
        ...workspace,
        access: "FULL" as const,
      }))
    } else {
      // Keep a deleted/suspended binding inspectable instead of silently
      // relabelling it as USER. The token validator independently fails it.
      binding = {
        mode: "AGENT",
        agentName: consent.agentId ? agents.get(consent.agentId)?.name ?? "Unavailable agent" : "Unavailable agent",
      }
      workspaces = input.grants.flatMap((grant): ConnectedAppWorkspace[] => {
        if (!consent.agentId || grant.agentId !== consent.agentId) return []
        const workspace = input.memberWorkspaces.get(grant.workspaceId)
        if (!workspace) return []
        return [{
          ...workspace,
          access: grant.access === "WRITE" ? "WRITE" : "READ",
        }]
      })
    }
    workspaces.sort(
      (a, b) =>
        collator.compare(a.organizationName, b.organizationName) ||
        collator.compare(a.workspaceName, b.workspaceName),
    )

    return [{
      id: consent.id,
      clientName: client.clientName,
      redirectHosts: redirectHosts(client.redirectUris),
      binding,
      scopes: splitScopes(consent.scope),
      workspaces,
      grantedAt: consent.grantedAt,
      lastUsedAt: newestUse(input.tokens, consent.clientId),
    }]
  })
}

/** Load only the signed-in account's connection material. */
export async function getConnectedAppsForUser(userId: string): Promise<ConnectedApp[]> {
  const prisma = getPrisma()
  const consents = await prisma.oAuthConsent.findMany({
    where: { userId },
    select: {
      id: true,
      clientId: true,
      scope: true,
      authorizationMode: true,
      agentId: true,
      grantedAt: true,
    },
    orderBy: { grantedAt: "desc" },
  })
  if (consents.length === 0) return []

  const clientIds = [...new Set(consents.map((consent) => consent.clientId))]
  const agentIds = [...new Set(consents.flatMap((consent) => consent.agentId ? [consent.agentId] : []))]
  const [clients, tokens, agents, memberWorkspaceRows] = await Promise.all([
    prisma.oAuthClient.findMany({
      where: { clientId: { in: clientIds } },
      select: { clientId: true, clientName: true, redirectUris: true },
    }),
    prisma.oAuthToken.findMany({
      where: { userId, clientId: { in: clientIds } },
      select: { clientId: true, lastUsedAt: true },
    }),
    prisma.agent.findMany({
      where: { id: { in: agentIds }, ownerUserId: userId },
      select: { id: true, name: true },
    }),
    prisma.workspace.findMany({
      where: { members: { some: { userId } } },
      select: { id: true, name: true, organization: { select: { name: true } } },
    }),
  ])
  // Never use an agent id taken straight from a consent row to load grants.
  // First reduce it to agents this account actually owns; a corrupt row that
  // names somebody else's agent must not reveal that agent's grant set.
  const ownedAgentIds = agents.map((agent) => agent.id)
  const grants = ownedAgentIds.length > 0
    ? await prisma.agentWorkspaceGrant.findMany({
      where: { agentId: { in: ownedAgentIds }, revokedAt: null },
      select: { agentId: true, workspaceId: true, access: true },
    })
    : []

  const memberWorkspaces = new Map(
    memberWorkspaceRows.flatMap((workspace) => workspace.organization ? [[
      workspace.id,
      { workspaceName: workspace.name, organizationName: workspace.organization.name },
    ] as const] : []),
  )
  return buildConnectedApps({ consents, clients, tokens, agents, grants, memberWorkspaces })
}
