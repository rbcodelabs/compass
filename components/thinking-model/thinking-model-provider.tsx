"use client"

import { createContext, useContext } from "react"
import { CLASSIC_THINKING_MODEL, type ResolvedThinkingModel } from "@/lib/thinking-model/resolve"
import type { ResolvedLabels } from "@/lib/thinking-model/labels"

/**
 * Delivers the workspace's resolved thinking model to client components.
 *
 * The server workspace layout resolves once from the already-loaded workspace and
 * passes the plain result as `value`. Outside the provider (portal, help, embed,
 * public pages) the hooks return the CLASSIC defaults, so public surfaces are
 * unchanged.
 */
const ThinkingModelContext = createContext<ResolvedThinkingModel>(CLASSIC_THINKING_MODEL)

export function ThinkingModelProvider({
  value,
  children,
}: {
  value: ResolvedThinkingModel
  children: React.ReactNode
}) {
  return <ThinkingModelContext.Provider value={value}>{children}</ThinkingModelContext.Provider>
}

export function useThinkingModel(): ResolvedThinkingModel {
  return useContext(ThinkingModelContext)
}

export function useLabels(): ResolvedLabels {
  return useContext(ThinkingModelContext).labels
}
