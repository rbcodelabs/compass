"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, TrendingUp, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { CreateOpportunityForm } from "@/components/discovery/create-opportunity-form";
import {
  ACTIVE_OPPORTUNITY_STATUS_ORDER,
  filterOpportunitiesByTitle,
  groupOpportunitiesByStatus,
} from "@/lib/discovery-rail";
import type { OpportunityStatus, SquadData } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export type DiscoveryRailOpportunity = {
  id: string;
  title: string;
  status: OpportunityStatus;
  squad: { id: string; name: string; color: string } | null;
  linkedKeyResultId: string | null;
};

const STATUS_LABELS: Record<OpportunityStatus, string> = {
  EXPLORING: "Exploring",
  VALIDATING: "Validating",
  PRIORITIZED: "Prioritized",
  ACTIVE: "Active",
  ARCHIVED: "Archived",
};

const COLLAPSE_STORAGE_KEY = "discovery-rail-collapsed";

type DiscoveryRailProps = {
  variant: "sidebar" | "panel";
  opportunities: DiscoveryRailOpportunity[];
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  squads: SquadData[];
  activeOpportunityId?: string | null;
  onNavigate?: () => void;
};

export function DiscoveryRail({
  variant,
  opportunities,
  orgSlug,
  workspaceSlug,
  workspaceId,
  squads,
  activeOpportunityId = null,
  onNavigate,
}: DiscoveryRailProps) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    if (variant !== "sidebar") return;
    setCollapsed(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "true");
  }, [variant]);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next));
      return next;
    });
  }

  const filtered = filterOpportunitiesByTitle(opportunities, query);
  const { active, archived } = groupOpportunitiesByStatus(filtered);
  const base = `/${orgSlug}/${workspaceSlug}/discovery`;

  if (variant === "sidebar" && collapsed) {
    return (
      <div className="hidden md:flex w-12 shrink-0 flex-col items-center border-r border-border-default bg-surface-panel py-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={toggleCollapsed}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Expand discovery rail"
        >
          <PanelLeftOpen className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden",
        variant === "sidebar"
          ? "hidden md:flex w-64 shrink-0 border-r border-border-default bg-surface-panel"
          : "min-h-0 flex-1"
      )}
    >
      {/* Search + collapse toggle */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-default p-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search opportunities…"
            className="h-8 w-full bg-transparent pl-7 pr-2 text-xs"
          />
        </div>
        {variant === "sidebar" && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={toggleCollapsed}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Collapse discovery rail"
          >
            <PanelLeftClose className="size-4" />
          </Button>
        )}
      </div>

      {/* Grouped list */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-2">
        {ACTIVE_OPPORTUNITY_STATUS_ORDER.map((status) => {
          const items = active[status];
          if (items.length === 0) return null;
          return (
            <div key={status} className="flex flex-col gap-1">
              <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {STATUS_LABELS[status]} ({items.length})
              </p>
              {items.map((opp) => (
                <RailRow
                  key={opp.id}
                  opportunity={opp}
                  href={`${base}/${opp.id}`}
                  isActive={opp.id === activeOpportunityId}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          );
        })}

        {archived.length > 0 && (
          <Collapsible className="group">
            <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="h-7 w-full justify-start px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" />}>
              <span className="inline-block transition-transform group-data-open:rotate-90">▶</span>
              Archived ({archived.length})
            </CollapsibleTrigger>
            <CollapsibleContent>
            <div className="mt-1 flex flex-col gap-1">
              {archived.map((opp) => (
                <RailRow
                  key={opp.id}
                  opportunity={opp}
                  href={`${base}/${opp.id}`}
                  isActive={opp.id === activeOpportunityId}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {filtered.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No opportunities match &ldquo;{query}&rdquo;.
          </p>
        )}
      </div>

      {/* New opportunity */}
      <div className="shrink-0 border-t border-border-default p-2">
        <CreateOpportunityForm
          workspaceId={workspaceId}
          squads={squads}
          onCreated={(id) => {
            onNavigate?.();
            router.push(`${base}/${id}`);
          }}
        />
      </div>
    </div>
  );
}

function RailRow({
  opportunity,
  href,
  isActive,
  onNavigate,
}: {
  opportunity: DiscoveryRailOpportunity;
  href: string;
  isActive: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        "relative flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors",
        isActive
          ? "bg-primary/10 text-primary"
          : "text-text-secondary hover:bg-surface-inset hover:text-text-primary"
      )}
    >
      {isActive && (
        <span
          className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary"
          aria-hidden="true"
        />
      )}
      {opportunity.squad && (
        <span
          className="mt-0.5 size-2 shrink-0 rounded-full"
          style={{ backgroundColor: opportunity.squad.color }}
          title={opportunity.squad.name}
        />
      )}
      <span className="line-clamp-2 flex-1">{opportunity.title}</span>
      {opportunity.linkedKeyResultId && (
        <TrendingUp
          className="mt-0.5 size-3 shrink-0 text-primary"
          aria-label="Linked to a key result"
        />
      )}
    </Link>
  );
}
