"use client";

import React, { createContext, useContext, useCallback, useMemo, useRef } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { Horizon } from "@/lib/types";
import type { TaskCardData } from "@/components/tasks/task-card";

/**
 * The nine OST/roadmap/delivery entity types a detail panel can show. These
 * match lib/entity-detail.ts's EntityType and the Canvas node type strings
 * exactly, so a Canvas node (or any card) can call openPanel(node.type,
 * node.id) directly. "task" is the exception — it has no Canvas node, but
 * reuses the same panel machinery for its board/list/roadmap click targets.
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
  "task",
] as const;

export type EntityPanelType = (typeof PANEL_ENTITY_TYPES)[number];

/**
 * Panels that are not an existing entity's detail view:
 * - `discovery-rail` is a special mobile nav aid.
 * - `feedback-new` is the "New feedback" composer. It lives in the same slot
 *   (and the same `?detail=` param) as entity panels on purpose: after a
 *   submit the composer is *replaced* by the new item's detail panel, so
 *   creating and viewing are one continuous surface. Its id is always
 *   `FEEDBACK_COMPOSER_ID`.
 */
export type PanelType = EntityPanelType | "discovery-rail" | "feedback-new";

export const FEEDBACK_COMPOSER_ID = "new";

export type OpenPanelOptions = {
  /**
   * Replace the current history entry instead of pushing one. Used when one
   * panel supersedes another (composer → created item), so Back does not
   * return to an emptied composer.
   */
  replace?: boolean;
};

export type PanelState = {
  type: PanelType;
  id: string;
} | null;

// The open panel lives in this search param as `<type>:<id>`, so it is
// shareable, survives refresh, and the browser back button closes it.
const PANEL_PARAM = "detail";

const VALID_TYPES = new Set<string>([...PANEL_ENTITY_TYPES, "discovery-rail", "feedback-new"]);

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

/** The subset of an entity's fields a mutation notification can carry. Kept
 * narrow on purpose — this isn't a general data-sync channel, just enough for
 * a listener to apply the one change it cares about optimistically. `task`
 * carries the full card-shaped data because TaskBoard/TaskListView need to
 * patch their own local rows (they're panel siblings, not children) after any
 * of the ~9 editable fields changes in the panel. */
export type EntityMutationPatch = { horizon?: Horizon; updatedAt?: string; task?: TaskCardData };

type EntityMutationListener = (id: string, patch?: EntityMutationPatch) => void;

type PanelContextValue = {
  panel: PanelState;
  openPanel: (type: PanelType, id: string, options?: OpenPanelOptions) => void;
  closePanel: () => void;
  orgSlug: string;
  workspaceSlug: string;
  /**
   * Notify any subscribers that an entity was mutated by a panel — the panel
   * (PanelShell) is rendered as a sibling of the page content, not a child of
   * it, so a page's own client state (e.g. RoadmapBoard's optimistic column
   * state) can't receive the update via props. This is the escape hatch: the
   * panel calls notifyEntityMutated after a successful mutation, and any
   * page-level component that cares subscribes with subscribeEntityMutated.
   */
  notifyEntityMutated: (type: EntityPanelType, id: string, patch?: EntityMutationPatch) => void;
  subscribeEntityMutated: (type: EntityPanelType, listener: EntityMutationListener) => () => void;
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
    (type: PanelType, id: string, options?: OpenPanelOptions) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(PANEL_PARAM, encodePanel(type, id));
      const href = `${pathname}?${params.toString()}`;
      if (options?.replace) router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
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

  // Ref, not state — subscriber bookkeeping shouldn't trigger a re-render of
  // every panel consumer every time a board mounts/unmounts a listener.
  const listenersRef = useRef<Map<EntityPanelType, Set<EntityMutationListener>>>(new Map());

  const subscribeEntityMutated = useCallback(
    (type: EntityPanelType, listener: EntityMutationListener) => {
      let set = listenersRef.current.get(type);
      if (!set) {
        set = new Set();
        listenersRef.current.set(type, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    []
  );

  const notifyEntityMutated = useCallback(
    (type: EntityPanelType, id: string, patch?: EntityMutationPatch) => {
      listenersRef.current.get(type)?.forEach((listener) => listener(id, patch));
    },
    []
  );

  const value = useMemo(
    () => ({
      panel,
      openPanel,
      closePanel,
      orgSlug,
      workspaceSlug,
      notifyEntityMutated,
      subscribeEntityMutated,
    }),
    [panel, openPanel, closePanel, orgSlug, workspaceSlug, notifyEntityMutated, subscribeEntityMutated]
  );

  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

export function usePanelContext() {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error("usePanelContext must be used inside PanelProvider");
  return ctx;
}
