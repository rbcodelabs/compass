"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { RoadmapCard, type RoadmapCardData } from "./roadmap-card";
import { AddItemForm } from "./add-item-form";
import type { Horizon } from "@/lib/types";
import { HORIZON_META, isLaunchHorizon } from "@/lib/roadmap";
import { BoardColumn, EmptyState } from "@/components/patterns";

type AvailableKR = { id: string; title: string; objectiveTitle: string };
type AvailableSolution = { id: string; title: string; opportunityTitle: string };
type AvailableOpportunity = { id: string; title: string };
type AvailableExperiment = { id: string; title: string; status: string };

type Props = {
  horizon: Horizon;
  items: RoadmapCardData[];
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
  revalidatePathStr: string;
  onItemAdded: (item: RoadmapCardData) => void;
  onArchive: (itemId: string) => void;
  onUpdate: (item: RoadmapCardData) => void;
  availableKRs?: AvailableKR[];
  availableSolutions?: AvailableSolution[];
  availableOpportunities?: AvailableOpportunity[];
  availableExperiments?: AvailableExperiment[];
  // Purely visual/advisory WIP limit for this column — only ever passed for
  // NOW/NEXT. See docs/decisions/0005/0006 (Superseded); never wire this
  // into any blocking behavior.
  limit?: number | null;
  launchWorkflowEnabled?: boolean;
};

export function RoadmapColumn({
  horizon,
  items,
  workspaceId,
  orgSlug,
  workspaceSlug,
  revalidatePathStr,
  onItemAdded,
  onArchive,
  onUpdate,
  availableKRs,
  availableSolutions,
  availableOpportunities,
  availableExperiments,
  limit,
  launchWorkflowEnabled = true,
}: Props) {
  const { label, emptyText } = HORIZON_META[horizon];
  const accent = ({ NOW: "success", NEXT: "info", LATER: "neutral", LAUNCHING: "warning", LAUNCHED: "success", SHIPPED: "success" } as const)[horizon];
  const itemIds = items.map((i) => i.id);
  // A launch horizon (LAUNCHING/LAUNCHED) can't take a freshly-typed item —
  // items get there only via setLaunchTier — so don't offer the add form.
  const allowAdd = !isLaunchHorizon(horizon);

  const { setNodeRef, isOver } = useDroppable({ id: `column-${horizon}`, data: { horizon } });

  return (
    <BoardColumn
      title={label}
      count={items.length}
      limit={limit}
      accent={accent}
      className="min-w-[280px] flex-1 overflow-hidden md:h-full"
      bodyRef={setNodeRef}
      bodyId={`roadmap-column-${horizon}`}
      bodyClassName={`min-h-44 md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto ${
        isOver ? "rounded-lg bg-primary/5 ring-2 ring-inset ring-ring/25" : ""
      }`}
      footer={allowAdd ? <AddItemForm workspaceId={workspaceId} horizon={horizon} revalidatePathStr={revalidatePathStr} onAdd={onItemAdded} availableKRs={availableKRs} availableSolutions={availableSolutions} availableOpportunities={availableOpportunities} availableExperiments={availableExperiments} /> : undefined}
    >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {items.length === 0 ? (
            <EmptyState compact title={emptyText} className={isOver ? "border-border-interactive" : undefined} />
          ) : (
            items.map((item) => (
              <RoadmapCard
                key={item.id}
                item={item}
                workspaceId={workspaceId}
                revalidatePathStr={revalidatePathStr}
                onArchive={onArchive}
                onUpdate={onUpdate}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                availableOpportunities={availableOpportunities}
                launchWorkflowEnabled={launchWorkflowEnabled}
              />
            ))
          )}
        </SortableContext>
    </BoardColumn>
  );
}
