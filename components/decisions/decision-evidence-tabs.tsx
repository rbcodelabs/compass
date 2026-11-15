"use client"

import type { ReactNode } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export function DecisionEvidenceTabs({
  contextContent,
  sourcesContent,
  evidenceCount,
  historyContent,
  revisionCount,
}: {
  contextContent: ReactNode
  sourcesContent: ReactNode
  evidenceCount: number
  historyContent?: ReactNode
  revisionCount?: number
}) {
  return (
    <Tabs defaultValue="context" className="min-w-0 max-w-full gap-4">
      <div className="min-w-0 max-w-full overflow-x-auto border-b border-border-default">
        <TabsList variant="line" className="h-9 gap-3">
          <TabsTrigger value="context" className="flex-none px-2.5">
            Context
          </TabsTrigger>
          <TabsTrigger value="sources" className="flex-none px-2.5">
            Sources &amp; Artifacts
            {evidenceCount > 0 && (
              <span className="ml-1 rounded-full bg-surface-inset px-1.5 py-0.5 font-mono text-[11px] font-normal text-text-subtle tabular-nums">
                {evidenceCount}
              </span>
            )}
          </TabsTrigger>
          {historyContent && (
            <TabsTrigger value="history" className="flex-none px-2.5">
              History
              {typeof revisionCount === "number" && revisionCount > 1 && (
                <span className="ml-1 rounded-full bg-surface-inset px-1.5 py-0.5 font-mono text-[11px] font-normal text-text-subtle tabular-nums">
                  {revisionCount}
                </span>
              )}
            </TabsTrigger>
          )}
        </TabsList>
      </div>

      <TabsContent value="context" className="min-w-0 rounded-xl border border-border-default bg-surface-panel p-4 sm:p-5">
        <h2 className="sr-only">Context</h2>
        {contextContent}
      </TabsContent>

      <TabsContent value="sources" className="min-w-0 rounded-xl border border-border-default bg-surface-panel p-4 sm:p-5">
        {sourcesContent}
      </TabsContent>

      {historyContent && (
        <TabsContent value="history" className="min-w-0 space-y-3">
          {historyContent}
        </TabsContent>
      )}
    </Tabs>
  )
}
