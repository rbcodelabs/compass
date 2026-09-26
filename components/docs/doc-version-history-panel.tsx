"use client"

import { useState, useTransition } from "react"
import { RotateCcw } from "lucide-react"
import diff_match_patch from "diff-match-patch"
import { DocPanelShell } from "@/components/docs/doc-panel-shell"
import type { PanelPin } from "@/lib/panel-pin"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { relativeTime } from "@/lib/relative-time"
import {
  getDocVersionContent,
  restoreDocVersion,
} from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"

export interface DocVersionListItem {
  id: string
  label: string | null
  createdByName: string | null
  createdAt: Date
}

interface DocVersionHistoryPanelProps {
  restore?: (versionId: string, content: string | null) => Promise<{ title: string }>;
  initialPin?: PanelPin
  open: boolean
  onOpenChange: (open: boolean) => void
  currentTitle: string
  currentContent: string | null
  versions: DocVersionListItem[]
  revalidatePathStr: string
  /** Called after a successful restore so the parent editor can reload the new content. */
  onRestored?: (content: string | null, title: string) => void
}

interface LoadedVersion {
  id: string
  title: string
  content: string | null
  createdAt: Date
  label: string | null
  createdByName: string | null
}

export function DocVersionHistoryPanel({
  restore,
  initialPin,
  open,
  onOpenChange,
  currentTitle,
  currentContent,
  versions,
  revalidatePathStr,
  onRestored,
}: DocVersionHistoryPanelProps) {
  const [selected, setSelected] = useState<LoadedVersion | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function handleSelectVersion(versionId: string) {
    setLoadingId(versionId)
    setError(null)
    try {
      const version = await getDocVersionContent(versionId)
      setSelected(version)
    } catch {
      setError("Couldn't load that version. Try again.")
    } finally {
      setLoadingId(null)
    }
  }

  function handleRestore(versionId: string, pinned: boolean) {
    const confirmed = window.confirm(
      "Restore this version? Your current content will be saved as a new version first, so nothing is lost."
    )
    if (!confirmed) return

    startTransition(async () => {
      setError(null)
      try {
        const restored = restore ? await restore(versionId, selected?.content ?? null) : await restoreDocVersion(versionId, revalidatePathStr)
        if (!restore) onRestored?.(selected?.content ?? null, restored.title)
        if (!pinned) onOpenChange(false)
        setSelected(null)
      } catch {
        setError("Couldn't restore that version. Try again.")
      }
    })
  }

  return (
    <DocPanelShell panelId="docsHistory" title="Version History" open={open} onOpenChange={onOpenChange} initialPin={initialPin}>
      {(pinned) => (
          <div className="flex-1 overflow-y-auto min-h-0">
            {error && (
              <p className="px-4 pt-3 text-xs text-status-danger" role="alert">
                {error}
              </p>
            )}

            {selected ? (
              <VersionDiffView
                version={selected}
                currentContent={currentContent}
                onBack={() => setSelected(null)}
                onRestore={() => handleRestore(selected.id, pinned)}
                isRestoring={isPending}
              />
            ) : (
              <VersionList
                currentTitle={currentTitle}
                versions={versions}
                loadingId={loadingId}
                onSelect={handleSelectVersion}
              />
            )}
          </div>
      )}
    </DocPanelShell>
  )
}

function VersionList({
  currentTitle,
  versions,
  loadingId,
  onSelect,
}: {
  currentTitle: string
  versions: DocVersionListItem[]
  loadingId: string | null
  onSelect: (versionId: string) => void
}) {
  return (
    <div className="p-2">
      <div className="px-2 py-2 mb-1 rounded-md bg-surface-inset">
        <p className="text-sm font-medium text-text-primary">{currentTitle || "Untitled"}</p>
        <p className="text-xs text-text-subtle">Current version</p>
      </div>

      {versions.length === 0 ? (
        <p className="text-xs text-text-subtle px-2 py-3">
          No saved versions yet. Versions appear here automatically as you edit, or you can save a
          named snapshot from the toolbar.
        </p>
      ) : (
        <ul className="space-y-0.5" data-testid="doc-version-list">
          {versions.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => onSelect(v.id)}
                disabled={loadingId === v.id}
                className="w-full text-left px-2 py-2 rounded-md text-sm hover:bg-surface-interactive transition-colors disabled:opacity-50"
              >
                {v.label && (
                  <span className="inline-block mb-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide bg-status-info-surface text-status-info">
                    {v.label}
                  </span>
                )}
                <p className="text-text-secondary">
                  {v.createdByName ?? "Unknown"}
                  {loadingId === v.id && "…"}
                </p>
                <p className="text-xs text-text-subtle" title={v.createdAt.toISOString()}>
                  {relativeTime(v.createdAt)}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function VersionDiffView({
  version,
  currentContent,
  onBack,
  onRestore,
  isRestoring,
}: {
  version: LoadedVersion
  currentContent: string | null
  onBack: () => void
  onRestore: () => void
  isRestoring: boolean
}) {
  const diffs = diffContent(version.content ?? "", currentContent ?? "")

  return (
    <div className="p-3 flex flex-col gap-3">
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-text-subtle hover:text-text-primary self-start"
      >
        ← Back to versions
      </button>

      <div>
        {version.label && (
          <span className="inline-block mb-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide bg-status-info-surface text-status-info">
            {version.label}
          </span>
        )}
        <p className="text-sm font-medium text-text-primary">{version.title || "Untitled"}</p>
        <p className="text-xs text-text-subtle">
          {version.createdByName ?? "Unknown"} — {relativeTime(version.createdAt)}
        </p>
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRestore}
        disabled={isRestoring}
        className="self-start gap-1.5"
      >
        <RotateCcw className="w-3.5 h-3.5" />
        {isRestoring ? "Restoring…" : "Restore this version"}
      </Button>

      <div
        data-testid="doc-version-diff"
        className="text-sm leading-relaxed whitespace-pre-wrap break-words rounded-md border border-border-default bg-surface-card p-3"
      >
        {diffs.map(([op, text], i) => (
          <span
            key={i}
            className={cn(
              op === diff_match_patch.DIFF_INSERT &&
                "bg-status-success-surface text-status-success",
              op === diff_match_patch.DIFF_DELETE &&
                "bg-status-danger-surface text-status-danger line-through"
            )}
          >
            {text}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Diffs the saved version's content against the doc's current content.
 * diff_main operates char-by-char; diff_cleanupSemantic groups the raw
 * output into more human-readable chunks before rendering.
 */
function diffContent(oldText: string, newText: string) {
  const dmp = new diff_match_patch()
  const diffs = dmp.diff_main(oldText, newText)
  dmp.diff_cleanupSemantic(diffs)
  return diffs
}
