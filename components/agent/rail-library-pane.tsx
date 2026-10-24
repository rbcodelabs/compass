"use client"

import { useCallback, useEffect, useState } from "react"
import { usePathname } from "next/navigation"

import { DocTreeSidebar, type DocTreeItem } from "@/components/docs/doc-tree-sidebar"
import type { ArtifactNavItem } from "@/components/docs/artifact-nav"
import { useLiveRefresh } from "@/hooks/use-live-refresh"

type Library = { workspaceId: string; docs: DocTreeItem[]; artifacts: ArtifactNavItem[] }

/**
 * The rail's Library view: the Docs screen's Library tree, available from any
 * screen.
 *
 * The Docs route layout hands `DocTreeSidebar` its data as server-rendered
 * props. The rail lives in the workspace layout — outside that route and never
 * re-rendered by navigation — so it fetches /api/docs-tree instead.
 *
 * Fetches only once the view has been shown (`active`), then again whenever the
 * route changes while it is showing, which is also how a doc created from the
 * tree appears: creating one navigates to it. Stale data stays on screen during
 * a refetch rather than flashing a loader.
 *
 * Opening an item navigates the main area and leaves the rail where it is.
 */
export function RailLibraryPane({
  orgSlug,
  workspaceSlug,
  active,
}: {
  orgSlug: string
  workspaceSlug: string
  active: boolean
}) {
  const pathname = usePathname()
  const [library, setLibrary] = useState<Library | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (isCancelled: () => boolean) => {
    try {
      const qs = new URLSearchParams({ orgSlug, workspaceSlug })
      const res = await fetch(`/api/docs-tree?${qs}`)
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as Library
      if (!isCancelled()) {
        setLibrary(data)
        setFailed(false)
      }
    } catch {
      if (!isCancelled()) setFailed(true)
    }
  }, [orgSlug, workspaceSlug])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void load(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [active, load, pathname])

  // The tree is client-fetched, so a change (an agent adding, renaming or moving
  // a doc or artifact) refetches it rather than refreshing the route. Polls only
  // while the Library view is the one showing.
  useLiveRefresh({
    orgSlug,
    workspaceSlug,
    scope: "docs-tree",
    onChange: () => void load(() => false),
    enabled: active,
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col px-2 pt-2" data-testid="rail-library">
      {library ? (
        <DocTreeSidebar
          docs={library.docs}
          artifacts={library.artifacts}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceId={library.workspaceId}
        />
      ) : failed ? (
        <p className="px-2 text-sm text-text-subtle">The library couldn’t be loaded.</p>
      ) : (
        <p className="px-2 text-xs text-text-subtle">Loading…</p>
      )}
    </div>
  )
}
