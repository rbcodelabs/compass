"use client"

import { Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { usePageSuggestions } from "@/components/agent/use-page-suggestions"

export type EmptyRailSuggestionsStackProps = {
  label: string | null
  pageUrl: string
  suggestions: readonly string[]
  loading?: boolean
  pinnedWhileTyping?: boolean
  disabled?: boolean
  onFire: (prompt: string, pageUrl: string) => void
  onEdit: (prompt: string) => void
}

const SKELETON_WIDTHS = ["w-11/12", "w-4/5", "w-3/4"] as const

export function EmptyRailSuggestionsStack({
  label,
  pageUrl,
  suggestions,
  loading = false,
  pinnedWhileTyping = false,
  disabled = false,
  onFire,
  onEdit,
}: EmptyRailSuggestionsStackProps) {
  const isSkeleton = loading && suggestions.length === 0
  if (!loading && suggestions.length === 0) {
    return null
  }

  return (
    <div data-testid="empty-rail-suggestions" className="mb-2.5 select-none">
      <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
        {isSkeleton && !label ? (
          <span className="min-w-0 truncate text-[11px] font-medium text-text-subtle">
            Thinking of questions…
          </span>
        ) : (
          <span className="min-w-0 truncate text-[11px] font-medium text-text-subtle">
            Viewing · <span className="text-text-secondary">{label ?? "Current screen"}</span>
          </span>
        )}
        {pinnedWhileTyping && !loading && (
          <span
            data-testid="empty-rail-suggestions-pinned"
            className="shrink-0 text-[11px] text-text-subtle"
          >
            Pinned while typing
          </span>
        )}
      </div>

      <div
        className="divide-y divide-border-default border-y border-border-default"
        aria-busy={isSkeleton ? "true" : undefined}
      >
        {isSkeleton
          ? SKELETON_WIDTHS.map((widthClass, idx) => (
              <div
                key={idx}
                data-testid="empty-rail-suggestion-skeleton"
                className="px-1 py-2.5"
              >
                <div
                  className={`h-3.5 rounded bg-surface-inset animate-pulse motion-reduce:animate-none ${widthClass}`}
                />
              </div>
            ))
          : suggestions.map((prompt) => (
              <div key={prompt} className="group flex items-center gap-1">
                <button
                  type="button"
                  data-testid="empty-rail-suggestion-fire"
                  disabled={disabled}
                  onClick={() => onFire(prompt, pageUrl)}
                  className="min-w-0 flex-1 rounded-sm px-1 py-2 text-left text-[13px] leading-snug text-text-secondary transition-colors hover:bg-surface-interactive hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50"
                >
                  {prompt}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-testid="empty-rail-suggestion-edit"
                  disabled={disabled}
                  aria-label="Edit prompt in composer"
                  title="Edit in composer"
                  onClick={() => onEdit(prompt)}
                  className="shrink-0 text-text-subtle opacity-0 transition-opacity hover:text-text-primary group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <Pencil className="size-3" aria-hidden="true" />
                </Button>
              </div>
            ))}
      </div>
    </div>
  )
}

export type EmptyRailSuggestionsProps = {
  workspaceId: string
  enabled: boolean
  hasDraft: boolean
  disabled?: boolean
  onFire: (prompt: string, pageUrl: string) => void
  onEdit: (prompt: string) => void
}

export function EmptyRailSuggestions({
  workspaceId,
  enabled,
  hasDraft,
  disabled = false,
  onFire,
  onEdit,
}: EmptyRailSuggestionsProps) {
  const { label, pageUrl, suggestions, loading, pinnedWhileTyping } = usePageSuggestions({
    workspaceId,
    enabled,
    hasDraft,
  })

  return (
    <EmptyRailSuggestionsStack
      label={label}
      pageUrl={pageUrl}
      suggestions={suggestions}
      loading={loading}
      pinnedWhileTyping={pinnedWhileTyping}
      disabled={disabled}
      onFire={onFire}
      onEdit={onEdit}
    />
  )
}
