"use client";

import { Library } from "lucide-react";

import { useAgentRailOptional } from "@/components/agent/agent-rail-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Header control for the Docs screens: shows the Library in the agent rail.
 *
 * The Library is the rail's "Library" view, not a sidebar of the Docs route.
 * Pressing this opens the rail and switches it to that view; pressing it again
 * while the Library is showing closes the rail. Visible at every breakpoint —
 * on narrow screens the rail is an overlay drawer, which replaces the old
 * Pages drawer.
 *
 * Renders nothing where there is no rail to open (outside a workspace, or on
 * the full-page agent screen).
 */
export function DocsLibraryButton({ className }: { className?: string }) {
  const rail = useAgentRailOptional();
  if (!rail?.available) return null;

  const showing = rail.open && rail.view === "library";
  const label = showing ? "Hide library" : "Show library";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={() => (showing ? rail.closeRail() : rail.openLibrary())}
      aria-label={label}
      aria-pressed={showing}
      title={label}
      data-testid="library-toggle"
      className={cn("shrink-0 text-text-subtle hover:text-text-primary", className)}
    >
      <Library className="size-3.5" aria-hidden="true" />
    </Button>
  );
}
