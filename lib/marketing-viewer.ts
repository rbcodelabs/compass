import { cache } from "react"

import { auth } from "@/auth"
import { getUserWorkspaces, type UserWorkspace } from "@/lib/workspace"

type MarketingUser = {
  name: string
  email: string
  image: string | null
}

export type MarketingViewer =
  | { kind: "signed-out" }
  | { kind: "no-workspaces"; user: MarketingUser; workspaces: [] }
  | { kind: "single-workspace"; user: MarketingUser; workspaces: [UserWorkspace] }
  | { kind: "multiple-workspaces"; user: MarketingUser; workspaces: UserWorkspace[] }

export const getMarketingViewer = cache(async (): Promise<MarketingViewer> => {
  const session = await auth()
  if (!session?.user?.id) return { kind: "signed-out" }

  const workspaces = await getUserWorkspaces(session.user.id)
  const user = {
    name: session.user.name || session.user.email || "Compass user",
    email: session.user.email || "",
    image: session.user.image || null,
  }

  if (workspaces.length === 0) return { kind: "no-workspaces", user, workspaces: [] }
  if (workspaces.length === 1) {
    return { kind: "single-workspace", user, workspaces: [workspaces[0]] }
  }
  return { kind: "multiple-workspaces", user, workspaces }
})
