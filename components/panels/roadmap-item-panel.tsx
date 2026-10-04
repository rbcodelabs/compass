"use client";

import { RoadmapItemDetail } from "@/components/roadmap/roadmap-item-detail";

export function RoadmapItemPanel({ id, orgSlug, workspaceSlug }: { id: string; orgSlug: string; workspaceSlug: string }) {
  return <RoadmapItemDetail itemId={id} orgSlug={orgSlug} workspaceSlug={workspaceSlug} variant="panel" />;
}
