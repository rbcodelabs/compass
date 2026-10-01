"use client"

import { useState, useTransition } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  linkSolutionToKeyResultAction,
  unlinkSolutionFromKeyResultAction,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/solution-link-actions"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"

/**
 * The Solution <-> Key Result picker (Phase 4B): a multi-select that links or unlinks the solution to any number
 * of Key Results in its workspace. Shown on the Solution panel only by presets that offer this link
 * (links.solToKr is "primary" or "secondary"); the caller decides, this component just renders. Every name comes
 * from useLabels().
 *
 * Writes go through server actions that derive the workspace from the solution and pair-check the Key Result, so
 * nothing here sends a workspace id.
 */
export type PickerKeyResult = { id: string; title: string; objectiveTitle?: string | null }

type Props = {
  solutionId: string
  linked: Array<{ id: string; title: string }>
  available: PickerKeyResult[]
  /** The link table could not be read: the list above may be incomplete and writes would fail, so none are offered. */
  linksUnavailable?: boolean
  onChanged?: () => void
}

export function SolutionKeyResultPicker({ solutionId, linked, available, linksUnavailable = false, onChanged }: Props) {
  const labels = useLabels()
  const [isPending, startTransition] = useTransition()
  const [linkedIds, setLinkedIds] = useState<string[]>(() => linked.map((kr) => kr.id))
  const [message, setMessage] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  // Stay in step with the server once a refresh delivers new props (adjusting state during render,
  // not in an effect, so the open menu is not remounted between toggles).
  const signature = linked.map((kr) => kr.id).join(",")
  const [seenSignature, setSeenSignature] = useState(signature)
  if (seenSignature !== signature) {
    setSeenSignature(signature)
    setLinkedIds(signature ? signature.split(",") : [])
  }

  const titleById = new Map([...linked, ...available].map((kr) => [kr.id, kr.title]))
  const readOnly = linksUnavailable || unavailable

  function toggle(keyResultId: string, next: boolean) {
    setMessage(null)
    startTransition(async () => {
      try {
        const result = next
          ? await linkSolutionToKeyResultAction(solutionId, keyResultId)
          : await unlinkSolutionFromKeyResultAction(solutionId, keyResultId)
        if (!result.ok) {
          if (result.linksUnavailable) setUnavailable(true)
          setMessage(result.error)
          return
        }
        setLinkedIds((current) => (next ? [...new Set([...current, keyResultId])] : current.filter((id) => id !== keyResultId)))
        onChanged?.()
      } catch {
        setMessage(`Could not update ${labels.keyResult.lowerPlural}.`)
      }
    })
  }

  return (
    <div data-testid="solution-key-result-picker" className="flex flex-wrap items-center gap-2 rounded-lg border border-border-default bg-surface-inset p-3">
      {linkedIds.length > 0 ? (
        <ul aria-label={`Linked ${labels.keyResult.lowerPlural}`} className="flex flex-wrap items-center gap-1.5">
          {linkedIds.map((id) => (
            <li key={id} className="inline-flex max-w-full items-center rounded-full border border-border-default bg-surface-panel px-2 py-0.5 text-xs text-text-primary">
              <span className="break-words">{titleById.get(id) ?? id}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No {labels.keyResult.lowerPlural} linked.</p>
      )}

      {readOnly && (
        <p role="status" data-testid="solution-links-unavailable" className="w-full text-xs text-muted-foreground">
          Link data is unavailable right now, so this list may be incomplete and changes are off.
        </p>
      )}

      {available.length > 0 && !readOnly && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button type="button" variant="ghost" size="sm" disabled={isPending} aria-label={`Choose ${labels.keyResult.lowerPlural}`} />}
          >
            <span className="underline underline-offset-2 decoration-dashed">{linkedIds.length > 0 ? "Change" : `Link ${labels.keyResult.lowerPlural}`}</span>
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-72 overflow-y-auto">
            {available.map((keyResult) => (
              <DropdownMenuCheckboxItem
                key={keyResult.id}
                checked={linkedIds.includes(keyResult.id)}
                closeOnClick={false}
                disabled={isPending}
                onCheckedChange={(next) => toggle(keyResult.id, next)}
              >
                <span className="truncate">{keyResult.title}</span>
                {keyResult.objectiveTitle && <span className="ml-auto shrink-0 pr-4 text-xs text-muted-foreground">{keyResult.objectiveTitle}</span>}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {available.length === 0 && !readOnly && linkedIds.length === 0 && (
        <p className="w-full text-xs text-muted-foreground">There are no {labels.keyResult.lowerPlural} in this workspace yet.</p>
      )}

      {message && (
        <p role="alert" className="w-full text-xs text-destructive">
          {message}
        </p>
      )}
    </div>
  )
}
