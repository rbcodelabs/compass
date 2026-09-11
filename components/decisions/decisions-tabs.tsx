"use client"

import { useUrlState } from "@/hooks/use-url-state"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

type Tab = "PENDING" | "DECIDED"

/**
 * Pending/Decided switch, replacing the raw underlined `<Link>`s with the
 * shared segmented `Tabs` control (same pattern as `TasksViewToggle`).
 * "Pending" is the default view, so — like the board/list toggle — it's
 * represented by the absence of the `tab` param rather than `?tab=pending`.
 */
export function DecisionsTabs({ tab }: { tab: Tab }) {
  const { set } = useUrlState()

  function setTab(next: string) {
    set({ tab: next === "DECIDED" ? "decided" : null, page: null })
  }

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as string)}>
      <TabsList>
        <TabsTrigger value="PENDING">Pending</TabsTrigger>
        <TabsTrigger value="DECIDED">Decided</TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
