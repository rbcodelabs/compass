"use client"

import * as React from "react"
import { useTransition } from "react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical } from "lucide-react"
import { EntityCard } from "@/components/patterns/entity-card"
import { StatusBadge } from "@/components/patterns/status-badge"
import { CardMenu } from "@/components/ui/card-menu"
import { usePanelContext } from "@/components/panels/panel-context"
import { archiveExperiment } from "@/app/[orgSlug]/[workspaceSlug]/experiments/actions"
import type { ExperimentStatus } from "@/lib/types"

export type ExperimentCardData = {
  id: string
  title: string
  hypothesis: string
  killCondition: string
  status: ExperimentStatus
  sortOrder: number
  conclusion: string | null
}

const STATUS_LABELS: Record<ExperimentStatus, string> = {
  DESIGNING: "Designing",
  RUNNING: "Running",
  COMPLETE: "Complete",
  KILLED: "Killed",
}

const STATUS_TONE: Record<ExperimentStatus, "neutral" | "info" | "success" | "danger"> = {
  DESIGNING: "neutral", RUNNING: "info", COMPLETE: "success", KILLED: "danger",
}

interface ExperimentCardProps {
  experiment: ExperimentCardData
  revalidatePathStr: string
}

export function ExperimentCard({ experiment, revalidatePathStr }: ExperimentCardProps) {
  const [, startTransition] = useTransition()
  const { openPanel } = usePanelContext()

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: experiment.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  const statusLabel = STATUS_LABELS[experiment.status]

  function handleArchive() {
    startTransition(async () => {
      await archiveExperiment(experiment.id, revalidatePathStr)
    })
  }

  return (
    <div ref={setNodeRef} style={style} className="touch-none group">
      <EntityCard
        interactive
        className="w-full p-3 data-[dragging=true]:shadow-[var(--shadow-panel)] data-[dragging=true]:ring-2 data-[dragging=true]:ring-ring/30"
        data-dragging={isDragging ? true : undefined}
        leading={
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="shrink-0 cursor-grab touch-none rounded text-text-subtle/60 hover:text-text-subtle active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
            aria-label="Drag to reorder"
          >
            <GripVertical className="size-3.5" />
          </button>
        }
        title={<button
                type="button"
                onClick={() => openPanel("experiment", experiment.id)}
                className="line-clamp-2 text-left hover:underline underline-offset-2"
              >
                {experiment.title}
              </button>}
        description={experiment.hypothesis}
        status={<StatusBadge status={STATUS_TONE[experiment.status]}>{statusLabel}</StatusBadge>}
        actions={
          <CardMenu
            items={[
              {
                label: "Archive",
                onClick: () => handleArchive(),
                destructive: true,
              },
            ]}
          />
        }
      >
          {experiment.killCondition && (
            <p className="flex items-start gap-1 text-xs text-status-warning">
              <span aria-hidden="true">&#9888;</span>
              <span className="line-clamp-1">{experiment.killCondition}</span>
            </p>
          )}
      </EntityCard>
    </div>
  )
}
