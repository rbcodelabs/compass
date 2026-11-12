import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import Link from "next/link"
import { COMPACT_ROW_LIMIT, diffJson, type DiffKind, type DiffRow } from "@/lib/tool-approval/diff"
import type { Json } from "@/lib/tool-approval/packet"
import { cn } from "@/lib/utils"

// Every value is rendered as a React text child, so it is escaped by React; there is deliberately no raw-HTML path in this file.

const KIND_LABEL: Record<DiffKind, string> = { added: "Added", removed: "Removed", changed: "Changed", unchanged: "Unchanged", truncated: "Too large to show" }
const KIND_BADGE: Record<DiffKind, string> = {
  added: "bg-status-success-surface text-status-success",
  removed: "bg-status-danger-surface text-status-danger",
  changed: "bg-status-warning-surface text-status-warning",
  unchanged: "bg-status-neutral-surface text-status-neutral",
  truncated: "bg-status-warning-surface text-status-warning",
}

/** A value that may be a very long string or JSON: wraps inside its own box and scrolls there, never widening the page. */
function ValueBox({ side, text, empty }: { side: "before" | "after"; text?: string; empty: string }) {
  const present = text !== undefined
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[11px] font-medium tracking-wide text-text-subtle uppercase">{side === "before" ? "Before" : "After"}</p>
      <pre
        data-side={side}
        className={cn(
          "m-0 max-h-60 min-w-0 max-w-full overflow-auto rounded-md px-2 py-1.5 font-mono text-xs leading-snug break-words whitespace-pre-wrap [overflow-wrap:anywhere]",
          !present ? "bg-surface-inset text-text-subtle italic" : side === "before" ? "bg-status-danger-surface text-status-danger" : "bg-status-success-surface text-status-success",
        )}
      >
        {present ? text : empty}
      </pre>
    </div>
  )
}

function ChangedRow({ row, compact }: { row: DiffRow; compact: boolean }) {
  if (row.kind === "truncated") {
    return (
      <li data-testid="effect-diff-row" data-kind="truncated" className="min-w-0 rounded-lg border border-status-warning/40 bg-status-warning-surface p-3 text-sm text-status-warning">
        <span className="font-medium">{KIND_LABEL.truncated}</span>
        <code className="ml-2 font-mono text-xs break-words [overflow-wrap:anywhere]">{row.path}</code>
        <p className="m-0 mt-1 text-text-primary">Too deep or too large to display in full. Review the call arguments before deciding.</p>
      </li>
    )
  }
  return (
    <li data-testid="effect-diff-row" data-kind={row.kind} className="min-w-0 rounded-lg border border-border-default bg-surface-panel p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium", KIND_BADGE[row.kind])}>{KIND_LABEL[row.kind]}</span>
        <code className="min-w-0 font-mono text-xs break-words text-text-secondary [overflow-wrap:anywhere]">{row.path}</code>
      </div>
      <div className={cn("mt-2 grid min-w-0 gap-2", !compact && "md:grid-cols-2")}>
        {row.kind !== "added" && <ValueBox side="before" text={row.before} empty="(not set)" />}
        {row.kind === "added" && !compact && <ValueBox side="before" empty="(not set)" />}
        {row.kind !== "removed" && <ValueBox side="after" text={row.after} empty="(removed)" />}
        {row.kind === "removed" && !compact && <ValueBox side="after" empty="(removed)" />}
      </div>
    </li>
  )
}

/**
 * The effect of one approved call, side by side: what is there now and what it would become. Built from the stored packet by
 * the server; `compact` (the chat card) stacks the sides and caps the number of rows, pointing at the full page for the rest.
 */
export function EffectDiff({ before, after, compact = false, moreHref }: { before: Json; after: Json; compact?: boolean; moreHref?: string }) {
  const diff = diffJson(before, after)
  const limit = compact ? COMPACT_ROW_LIMIT : diff.changed.length
  const shown = diff.changed.slice(0, limit)
  const hidden = diff.changed.length - shown.length
  return (
    <div data-testid="effect-diff" className="min-w-0 space-y-3">
      {diff.changed.length === 0 ? (
        <p className="text-sm text-text-secondary">No visible change: the proposed state equals the current state.</p>
      ) : (
        <ul aria-label="Changes" className="m-0 flex list-none flex-col gap-2 p-0">
          {shown.map((row, index) => <ChangedRow key={`${row.path}-${index}`} row={row} compact={compact} />)}
        </ul>
      )}
      {hidden > 0 && (
        <p className="text-xs text-text-subtle">
          {hidden} more {hidden === 1 ? "change" : "changes"}{moreHref ? <> are on <Link className="inline-flex min-h-11 items-center font-medium text-primary underline sm:min-h-0" href={moreHref}>the full approval page</Link></> : " are not shown here"}.
        </p>
      )}
      {diff.omittedChanges > 0 && <p className="text-xs text-status-warning">{diff.omittedChanges} further changes are not displayed because this change is very large.</p>}
      {!compact && diff.unchanged.length > 0 && (
        <Collapsible className="min-w-0 rounded-lg border border-border-default bg-surface-panel text-sm">
          <CollapsibleTrigger className="flex min-h-11 w-full cursor-pointer items-center px-3 py-2 text-left text-text-secondary sm:min-h-9">
            {diff.unchanged.length + diff.omittedUnchanged} unchanged {diff.unchanged.length + diff.omittedUnchanged === 1 ? "value" : "values"}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="m-0 flex list-none flex-col gap-1 px-3 pb-3">
              {diff.unchanged.map((row, index) => (
                <li key={`${row.path}-${index}`} className="min-w-0 break-words font-mono text-xs text-text-subtle [overflow-wrap:anywhere]">
                  {row.path}: {row.after}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
