"use client";

import { useEffect, useState } from "react";
import { DiscoveryRail, type DiscoveryRailOpportunity } from "@/components/discovery/discovery-rail";
import { usePanelContext } from "./panel-context";
import type { SquadData } from "@/lib/types";

type DiscoveryRailData = {
  workspaceId: string;
  opportunities: DiscoveryRailOpportunity[];
  squads: SquadData[];
};

export function DiscoveryRailPanel({
  activeOpportunityId,
  orgSlug,
  workspaceSlug,
}: {
  activeOpportunityId: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const { closePanel } = usePanelContext();
  const [data, setData] = useState<DiscoveryRailData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setData(null);
    setError(false);
    fetch(`/api/panels/discovery-rail?orgSlug=${orgSlug}&workspaceSlug=${workspaceSlug}`)
      .then((r) => {
        if (!r.ok) throw new Error("fetch failed");
        return r.json();
      })
      .then(setData)
      .catch(() => setError(true));
  }, [orgSlug, workspaceSlug]);

  if (error) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Could not load opportunities.
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-4 px-5 pt-2 animate-pulse">
        <div className="h-4 w-2/3 rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-5/6 rounded bg-muted" />
        <div className="h-3 w-4/6 rounded bg-muted" />
      </div>
    );
  }

  return (
    <DiscoveryRail
      variant="panel"
      opportunities={data.opportunities}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      workspaceId={data.workspaceId}
      squads={data.squads}
      activeOpportunityId={activeOpportunityId || null}
      onNavigate={closePanel}
    />
  );
}
