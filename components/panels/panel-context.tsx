"use client";

import React, { createContext, useContext, useCallback, useMemo, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { Horizon } from "@/lib/types";
import type { TaskCardData } from "@/components/tasks/task-card";
import { COMPOSER_PANEL_TYPES, isComposerPanelType, type ComposerPanelType } from "./composer-panel-types";

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
 * - `opportunity-new` is the "New opportunity" composer, on the same terms.
 *   Its id is `new`, or `new-<status>` when a board column presets the
 *   starting status (see lib/opportunity-draft.ts).
 */
export { COMPOSER_PANEL_TYPES, isComposerPanelType, type ComposerPanelType };

export type PanelType = EntityPanelType | "discovery-rail" | ComposerPanelType;

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

const VALID_TYPES = new Set<string>([...PANEL_ENTITY_TYPES, "discovery-rail", ...COMPOSER_PANEL_TYPES]);

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

/**
 * How much horizontal room the detail panel is *actually* claiming as an
 * in-flow column right now — `docked: false` whenever it is rendered as an
 * overlay Sheet (or not open at all), so a consumer never has to also check
 * whether `panel` is non-null.
 *
 * This exists so the agent rail (`components/agent/agent-rail.tsx`) can react
 * to the detail panel docking or undocking without inferring it from the DOM.
 * An earlier version had the rail watch for a `[data-slot="pinned-panel"]`
 * element appearing/disappearing among its layout ancestor's children via a
 * `MutationObserver` — PanelShell's "Pin panel" toggle swaps *the same* panel
 * between a portaled Sheet and an in-flow aside without changing anything
 * about the open panel's identity (`?detail=` is untouched), so nothing the
 * rail already subscribed to told it this had happened. The DOM sniffing
 * technically worked in the layouts it was tested against, but it depended on
 * `[data-slot="pinned-panel"]` uniquely identifying the *right* aside — and it
 * doesn't: `components/docs/doc-panel-shell.tsx` renders the same data-slot
 * for the Docs Comments/History panels, nested inside main content rather
 * than as a sibling, so `wrapper.querySelector('[data-slot="pinned-panel"]')`
 * can resolve to the wrong element whenever both are pinned at once (several
 * `e2e/functional` specs already have to disambiguate with a second
 * `[data-panel-id]` attribute for exactly this reason). Reporting the state
 * PanelShell already computes, through the context both components already
 * share, removes the DOM as an intermediary entirely: no selector to get
 * wrong, no ancestor to mis-identify, and no observer wiring whose ordering
 * has to be reasoned about by hand.
 */
export type DetailPanelDock = { docked: boolean; width: number };

const NO_DETAIL_PANEL_DOCK: DetailPanelDock = Object.freeze({ docked: false, width: 0 });

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
  /** How much width the detail panel currently claims as an in-flow column. */
  detailPanelDock: DetailPanelDock;
  /**
   * PanelShell is the only writer. Optional so a test that mocks this context
   * for an unrelated component (there are dozens — none of them render
   * PanelShell) does not also have to stub a setter it will never call.
   */
  setDetailPanelDock?: (dock: DetailPanelDock) => void;
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

  // Reported by PanelShell (see DetailPanelDock's doc comment above). Starts
  // at "not docked" rather than guessing from a cookie: PanelShell itself
  // seeds correctly from the server-read pin preference and reports its real
  // computed value on its very first render, before the agent rail's own
  // layout effect ever reads this, so there is no flash to avoid here the way
  // there is for the pin preference itself.
  const [detailPanelDock, setDetailPanelDock] = useState<DetailPanelDock>(NO_DETAIL_PANEL_DOCK);

  const value = useMemo(
    () => ({
      panel,
      openPanel,
      closePanel,
      orgSlug,
      workspaceSlug,
      notifyEntityMutated,
      subscribeEntityMutated,
      detailPanelDock,
      setDetailPanelDock,
    }),
    [
      panel,
      openPanel,
      closePanel,
      orgSlug,
      workspaceSlug,
      notifyEntityMutated,
      subscribeEntityMutated,
      detailPanelDock,
    ]
  );

  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

export function usePanelContext() {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error("usePanelContext must be used inside PanelProvider");
  return ctx;
}
