"use client"

import * as React from "react"
import { useTransition } from "react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
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

const STATUS_CLASS: Record<ExperimentStatus, string> = {
  DESIGNING: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  RUNNING: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  COMPLETE: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  KILLED: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
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
  const statusClass = STATUS_CLASS[experiment.status]

  function handleArchive() {
    startTransition(async () => {
      await archiveExperiment(experiment.id, revalidatePathStr)
    })
  }

  return (
    <div ref={setNodeRef} style={style} className="touch-none group">
      <Card
        className="bg-white shadow-sm transition-all duration-150 group-hover:shadow-md data-[dragging=true]:shadow-xl data-[dragging=true]:ring-2 data-[dragging=true]:ring-indigo-200"
        data-dragging={isDragging ? true : undefined}
      >
        <CardHeader className="flex-row items-start gap-2 pr-2">
          {/* Drag handle */}
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="mt-0.5 shrink-0 cursor-grab touch-none text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            aria-label="Drag to reorder"
          >
            <GripVertical className="size-3.5" />
          </button>

          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => openPanel("experiment", experiment.id)}
                className="flex-1 text-left hover:underline underline-offset-2"
              >
                <CardTitle className="line-clamp-2 text-sm font-medium">
                  {experiment.title}
                </CardTitle>
              </button>
              <Badge className={statusClass + " shrink-0"}>{statusLabel}</Badge>
            </div>
          </div>

          <CardMenu
            items={[
              {
                label: "Archive",
                onClick: () => handleArchive(),
                destructive: true,
              },
            ]}
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground line-clamp-2">
            {experiment.hypothesis}
          </p>
          {experiment.killCondition && (
            <p className="text-xs text-amber-600 dark:text-amber-400 flex gap-1 items-start">
              <span aria-hidden="true">&#9888;</span>
              <span className="line-clamp-1">{experiment.killCondition}</span>
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
