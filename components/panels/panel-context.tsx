"use client";

import React, { createContext, useContext, useCallback, useMemo } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

/**
 * The eight OST/roadmap entity types a detail panel can show. These match
 * lib/entity-detail.ts's EntityType and the Canvas node type strings exactly,
 * so a Canvas node (or any card) can call openPanel(node.type, node.id)
 * directly.
 */
export const PANEL_ENTITY_TYPES = [
  "objective",
  "keyResult",
  "opportunity",
  "solution",
  "assumption",
  "experiment",
  "roadmapItem",
  "feedback",
] as const;

export type EntityPanelType = (typeof PANEL_ENTITY_TYPES)[number];

/** `discovery-rail` is a special mobile nav aid, not an entity detail. */
export type PanelType = EntityPanelType | "discovery-rail";

export type PanelState = {
  type: PanelType;
  id: string;
} | null;

// The open panel lives in this search param as `<type>:<id>`, so it is
// shareable, survives refresh, and the browser back button closes it.
const PANEL_PARAM = "detail";

const VALID_TYPES = new Set<string>([...PANEL_ENTITY_TYPES, "discovery-rail"]);

function encodePanel(type: PanelType, id: string): string {
  return `${type}:${id}`;
}

function decodePanel(raw: string | null): PanelState {
  if (!raw) return null;
  // Split on the first ":" only — entity ids are UUIDs (no colons), but be
  // defensive in case an id ever contains one.
  const sep = raw.indexOf(":");
  if (sep <= 0) return null;
  const type = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!id || !VALID_TYPES.has(type)) return null;
  return { type: type as PanelType, id };
}

type PanelContextValue = {
  panel: PanelState;
  openPanel: (type: PanelType, id: string) => void;
  closePanel: () => void;
  orgSlug: string;
  workspaceSlug: string;
};

const PanelContext = createContext<PanelContextValue | null>(null);

export function PanelProvider({
  children,
  orgSlug,
  workspaceSlug,
}: {
  children: React.ReactNode;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // URL is the single source of truth for what's open.
  const panel = useMemo(
    () => decodePanel(searchParams.get(PANEL_PARAM)),
    [searchParams]
  );

  // Open via push() so the browser back button removes the param (closes the
  // panel); hopping between related entities in a panel pushes each hop, so
  // back walks the chain. Preserve any other params already on the URL.
  const openPanel = useCallback(
    (type: PanelType, id: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(PANEL_PARAM, encodePanel(type, id));
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  // Close via replace() so an explicit close (X / Esc / backdrop) doesn't
  // leave a reopen-on-back entry behind.
  const closePanel = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete(PANEL_PARAM);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, pathname, searchParams]);

  const value = useMemo(
    () => ({ panel, openPanel, closePanel, orgSlug, workspaceSlug }),
    [panel, openPanel, closePanel, orgSlug, workspaceSlug]
  );

  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

export function usePanelContext() {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error("usePanelContext must be used inside PanelProvider");
  return ctx;
}
