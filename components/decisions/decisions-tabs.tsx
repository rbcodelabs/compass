"use client"

import { useUrlState } from "@/hooks/use-url-state"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

type Tab = "PENDING" | "DECIDED" | "AWAITING_FOLLOW_THROUGH"

const PARAM: Record<Tab, string | null> = {
  PENDING: null,
  DECIDED: "decided",
  AWAITING_FOLLOW_THROUGH: "awaiting",
}

/**
 * Pending/Decided/Awaiting switch, replacing the raw underlined `<Link>`s with
 * the shared segmented `Tabs` control (same pattern as `TasksViewToggle`).
 * "Pending" is the default view, so — like the board/list toggle — it's
 * represented by the absence of the `tab` param rather than `?tab=pending`.
 *
 * "Awaiting follow-through" is direction B's lens: decided, nothing linked,
 * not explicitly closed. It is computed rather than stored, so it lives here
 * as a third tab rather than a `state` value.
 */
export function DecisionsTabs({ tab }: { tab: Tab }) {
  const { set } = useUrlState()

  function setTab(next: string) {
    set({ tab: PARAM[next as Tab] ?? null, page: null })
  }

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as string)}>
      <TabsList>
        <TabsTrigger value="PENDING">Pending</TabsTrigger>
        <TabsTrigger value="DECIDED">Decided</TabsTrigger>
        <TabsTrigger value="AWAITING_FOLLOW_THROUGH">Awaiting follow-through</TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
