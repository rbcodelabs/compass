"use client"

import { Target } from "lucide-react"
import { useLabels, useThinkingModel } from "@/components/thinking-model/thinking-model-provider"

/**
 * An opportunity's typed Objective links, shown beside the legacy driving Key Result (Phase 4B, additive). Rendered only by
 * presets that offer the Opportunity <-> Objective link and only when there is something to show, so CLASSIC pages are
 * unchanged. Every name comes from useLabels().
 */
export function LinkedObjectivesStrip({ objectives }: { objectives?: Array<{ id: string; title: string }> }) {
  const labels = useLabels()
  const offered = useThinkingModel().links.oppToObjective !== "hidden"
  if (!offered || !objectives || objectives.length === 0) return null
  return (
    <div data-testid="linked-objectives" className="mb-3 flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-text-subtle">Linked {labels.objective.lowerPlural}</span>
      <ul aria-label={`Linked ${labels.objective.lowerPlural}`} className="flex flex-wrap items-center gap-1.5">
        {objectives.map((objective) => (
          <li
            key={objective.id}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-indigo-100 bg-indigo-50/60 px-2 py-0.5 text-xs text-indigo-800"
          >
            <Target aria-hidden className="size-3 shrink-0 text-indigo-500" />
            <span className="break-words">{objective.title}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
