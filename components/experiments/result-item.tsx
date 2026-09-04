import type { ExperimentResult } from "@prisma/client"
import { MarkdownContent } from "@/components/markdown-content"

interface ResultItemProps {
  result: ExperimentResult
}

export function ResultItem({ result }: ResultItemProps) {
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(result.createdAt))

  return (
    <div className="flex flex-col gap-1 py-3 border-b last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <time
          dateTime={result.createdAt.toISOString()}
          className="text-xs text-muted-foreground"
        >
          {date}
        </time>
        {result.metric != null && (
          <span className="text-xs font-mono bg-muted rounded px-1.5 py-0.5">
            {result.metric}
            {result.value != null ? ` = ${result.value}` : ""}
          </span>
        )}
      </div>
      <MarkdownContent>{result.note}</MarkdownContent>
    </div>
  )
}
