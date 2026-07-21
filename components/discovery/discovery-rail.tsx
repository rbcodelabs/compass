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
      <div className="hidden md:flex w-12 shrink-0 flex-col items-center border-r border-slate-200 bg-white py-3">
        <button
          onClick={toggleCollapsed}
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-slate-100 hover:text-foreground"
          aria-label="Expand discovery rail"
        >
          <PanelLeftOpen className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden",
        variant === "sidebar"
          ? "hidden md:flex w-64 shrink-0 border-r border-slate-200 bg-white"
          : "min-h-0 flex-1"
      )}
    >
      {/* Search + collapse toggle */}
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 p-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search opportunities…"
            className="w-full rounded-md border border-input bg-transparent py-1.5 pl-7 pr-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          />
        </div>
        {variant === "sidebar" && (
          <button
            onClick={toggleCollapsed}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-slate-100 hover:text-foreground"
            aria-label="Collapse discovery rail"
          >
            <PanelLeftClose className="size-4" />
          </button>
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
          <details className="group">
            <summary className="cursor-pointer list-none px-2 py-1">
              <span className="flex select-none items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span className="inline-block transition-transform group-open:rotate-90">▶</span>
                Archived ({archived.length})
              </span>
            </summary>
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
          </details>
        )}

        {filtered.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No opportunities match &ldquo;{query}&rdquo;.
          </p>
        )}
      </div>

      {/* New opportunity */}
      <div className="shrink-0 border-t border-slate-200 p-2">
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
          ? "bg-indigo-50 text-indigo-900"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      )}
    >
      {isActive && (
        <span
          className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-indigo-500"
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
          className="mt-0.5 size-3 shrink-0 text-indigo-500"
          aria-label="Linked to a key result"
        />
      )}
    </Link>
  );
}
