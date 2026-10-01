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
  linkOpportunityToObjectiveAction,
  unlinkOpportunityFromObjectiveAction,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/objective-link-actions"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"

/**
 * The minimal Opportunity <-> Objective picker (Phase 3C): a multi-select that links or
 * unlinks the opportunity to any number of Objectives. Shown only by presets that make
 * this link primary (TORRES_OST, OPPORTUNITY_FIRST_OKR); the caller decides, this
 * component just renders. Every name comes from useLabels().
 *
 * Writes go through server actions that derive the workspace from the opportunity and
 * pair-check the Objective, so nothing here sends a workspace id. A link that is derived
 * from the opportunity's legacy driving Key Result cannot be removed here; the action
 * says so and the checkbox stays checked.
 */
export type PickerObjective = { id: string; title: string; cycleTitle?: string | null }

type Props = {
  opportunityId: string
  linked: Array<{ id: string; title: string }>
  available: PickerObjective[]
  /** The link table could not be read: the list above may be incomplete and writes would fail, so none are offered. */
  linksUnavailable?: boolean
  onChanged?: () => void
}

export function OpportunityObjectivePicker({ opportunityId, linked, available, linksUnavailable = false, onChanged }: Props) {
  const labels = useLabels()
  const [isPending, startTransition] = useTransition()
  const [linkedIds, setLinkedIds] = useState<string[]>(() => linked.map((o) => o.id))
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null)

  // Stay in step with the server once a refresh delivers new props (adjusting state during render,
  // not in an effect, so the open menu is not remounted between toggles).
  const signature = linked.map((o) => o.id).join(",")
  const [seenSignature, setSeenSignature] = useState(signature)
  if (seenSignature !== signature) {
    setSeenSignature(signature)
    setLinkedIds(signature ? signature.split(",") : [])
  }

  const titleById = new Map([...linked, ...available].map((o) => [o.id, o.title]))

  function toggle(objectiveId: string, next: boolean) {
    setMessage(null)
    startTransition(async () => {
      try {
        const result = next
          ? await linkOpportunityToObjectiveAction(opportunityId, objectiveId)
          : await unlinkOpportunityFromObjectiveAction(opportunityId, objectiveId)
        if (!result.ok) {
          setMessage({ tone: "error", text: result.error })
          return
        }
        if (!next && result.stillLinkedViaKeyResult) {
          setMessage({
            tone: "info",
            text: `Still linked through its driving ${labels.keyResult.lower}. Change the ${labels.keyResult.lower} to remove it.`,
          })
          return
        }
        setLinkedIds((current) => (next ? [...new Set([...current, objectiveId])] : current.filter((id) => id !== objectiveId)))
        onChanged?.()
      } catch {
        setMessage({ tone: "error", text: `Could not update ${labels.objective.lowerPlural}.` })
      }
    })
  }

  return (
    <div data-testid="opportunity-objective-picker" className="flex flex-wrap items-center gap-2 rounded-lg border border-border-default bg-surface-inset p-3">
      <p className="w-full text-xs font-medium text-text-subtle">{labels.objective.plural}</p>
      {linkedIds.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-1.5">
          {linkedIds.map((id) => (
            <li key={id} className="inline-flex max-w-full items-center rounded-full border border-border-default bg-surface-panel px-2 py-0.5 text-xs text-text-primary">
              <span className="break-words">{titleById.get(id) ?? id}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No {labels.objective.lowerPlural} linked.</p>
      )}

      {linksUnavailable && (
        <p role="status" data-testid="picker-links-unavailable" className="w-full text-xs text-muted-foreground">
          Link data is unavailable right now, so this list may be incomplete and changes are off.
        </p>
      )}

      {available.length > 0 && !linksUnavailable && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button type="button" variant="ghost" size="sm" disabled={isPending} aria-label={`Choose ${labels.objective.lowerPlural}`} />}
          >
            <span className="underline underline-offset-2 decoration-dashed">{linkedIds.length > 0 ? "Change" : `Link ${labels.objective.lowerPlural}`}</span>
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-72 overflow-y-auto">
            {available.map((objective) => (
              <DropdownMenuCheckboxItem
                key={objective.id}
                checked={linkedIds.includes(objective.id)}
                closeOnClick={false}
                disabled={isPending}
                onCheckedChange={(next) => toggle(objective.id, next)}
              >
                <span className="truncate">{objective.title}</span>
                {objective.cycleTitle && <span className="ml-auto shrink-0 pr-4 text-xs text-muted-foreground">{objective.cycleTitle}</span>}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "w-full text-xs text-destructive" : "w-full text-xs text-muted-foreground"}>
          {message.text}
        </p>
      )}
    </div>
  )
}
