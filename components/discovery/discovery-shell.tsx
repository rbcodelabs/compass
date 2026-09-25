"use client";

import { usePathname } from "next/navigation";
import { DiscoveryRail, type DiscoveryRailOpportunity } from "@/components/discovery/discovery-rail";

type DiscoveryShellProps = {
  orgSlug: string;
  workspaceSlug: string;
  opportunities: DiscoveryRailOpportunity[];
  children: React.ReactNode;
};

export function DiscoveryShell({
  orgSlug,
  workspaceSlug,
  opportunities,
  children,
}: DiscoveryShellProps) {
  const pathname = usePathname();
  const base = `/${orgSlug}/${workspaceSlug}/discovery`;
  const afterBase = pathname.startsWith(base) ? pathname.slice(base.length) : null;
  // Matches exactly one more path segment, e.g. "/abc123" — the opportunity detail route.
  const detailMatch = afterBase ? /^\/([^/]+)\/?$/.exec(afterBase) : null;

  if (!detailMatch) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-full overflow-hidden">
      <DiscoveryRail
        variant="sidebar"
        opportunities={opportunities}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        activeOpportunityId={detailMatch[1]}
      />
      <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
