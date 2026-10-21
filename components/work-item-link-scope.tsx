"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { WorkspaceSlugs } from "@/lib/entity-links";

const WorkItemLinkScope = createContext<WorkspaceSlugs | null>(null);

/**
 * Tells MarkdownContent which workspace it is rendering in, so display IDs in prose (`TASK-12`) become links.
 * Outside a provider (the public portal, marketing pages) text is left alone.
 */
export function WorkItemLinkScopeProvider({ orgSlug, workspaceSlug, children }: WorkspaceSlugs & { children: ReactNode }) {
  const value = useMemo(() => ({ orgSlug, workspaceSlug }), [orgSlug, workspaceSlug]);
  return <WorkItemLinkScope.Provider value={value}>{children}</WorkItemLinkScope.Provider>;
}

export function useWorkItemLinkScope(): WorkspaceSlugs | null {
  return useContext(WorkItemLinkScope);
}
