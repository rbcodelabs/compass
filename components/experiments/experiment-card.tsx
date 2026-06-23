import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { Experiment } from "@prisma/client"

const STATUS_LABELS: Record<string, string> = {
  DESIGNING: "Designing",
  RUNNING: "Running",
  COMPLETE: "Complete",
  KILLED: "Killed",
}

// Maps status to badge className overrides that approximate the desired colors
// using Tailwind utility classes without needing extra variants.
const STATUS_CLASS: Record<string, string> = {
  DESIGNING: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  RUNNING: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  COMPLETE:
    "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  KILLED: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
}

interface ExperimentCardProps {
  experiment: Experiment
  href: string
}

export function ExperimentCard({ experiment, href }: ExperimentCardProps) {
  const statusLabel = STATUS_LABELS[experiment.status] ?? experiment.status
  const statusClass = STATUS_CLASS[experiment.status] ?? ""

  return (
    <Link href={href} className="block group">
      <Card className="transition-shadow group-hover:shadow-md">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="line-clamp-2 text-sm font-medium">
              {experiment.title}
            </CardTitle>
            <Badge className={statusClass}>{statusLabel}</Badge>
          </div>
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
    </Link>
  )
}
