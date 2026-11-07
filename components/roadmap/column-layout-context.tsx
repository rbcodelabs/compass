"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BoardLayout } from "@/lib/board-layout";
import { parseRoadmapBoardLayout, resolveRoadmapBoardLayout, serializeRoadmapBoardLayout } from "@/lib/roadmap/board-layout";

/**
 * The workspace roadmap's column layout (pinned / collapsed / order) as client state.
 *
 * Why a store and not a URL param: the layout is too noisy for the URL, but "Save" in the saved-views menu has to
 * capture it, and the menu (in the page header) and the board are siblings. The page wraps both in this provider;
 * the board reads and changes the layout, the menu reads `stored` to save it and to tell whether the selected view
 * has been modified.
 *
 * Where the starting layout comes from:
 *   - a saved view is selected: that view's `display.columnLayout` (absent = defaults). Changes stay in memory
 *     until saved. `sourceKey` identifies the view (and its version), so picking another view or saving this one
 *     resets the layout to the stored one, while a filter edit on the same view keeps it.
 *   - no saved view: the defaults, then whatever this browser last used for the workspace (localStorage, parsed
 *     tolerantly), mirrored on every change.
 */

export type ColumnLayoutController = {
  /** The layout, resolved against the board's columns. */
  layout: BoardLayout;
  /** Apply a pure transition from lib/board-layout.ts. A no-op transition (same reference back) changes nothing. */
  update: (transition: (layout: BoardLayout) => BoardLayout) => void;
  /** The form to put in a saved view: `undefined` when it is the default. */
  stored: BoardLayout | undefined;
};

const ColumnLayoutContext = createContext<ColumnLayoutController | null>(null);

const storageKey = (workspaceId: string) => `compass:roadmap-column-layout:${workspaceId}`;

function readLocal(workspaceId: string): BoardLayout | null {
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceId));
    return raw ? parseRoadmapBoardLayout(JSON.parse(raw)) : null;
  } catch {
    return null; // storage blocked, or the value isn't JSON: use the defaults
  }
}

function writeLocal(workspaceId: string, layout: BoardLayout) {
  try {
    const stored = serializeRoadmapBoardLayout(layout);
    if (stored) window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(stored));
    else window.localStorage.removeItem(storageKey(workspaceId));
  } catch {
    // best effort: the layout still applies for this session
  }
}

function useColumnLayoutStore({
  workspaceId,
  sourceKey,
  initial,
  mirrorLocal,
}: {
  workspaceId: string;
  sourceKey: string;
  initial: unknown;
  mirrorLocal: boolean;
}): ColumnLayoutController {
  const [state, setState] = useState(() => ({ sourceKey, layout: parseRoadmapBoardLayout(initial) }));
  // A different saved view (or a new version of it) starts over from what it stored.
  const current = state.sourceKey === sourceKey ? state : { sourceKey, layout: parseRoadmapBoardLayout(initial) };
  if (current !== state) setState(current);
  const layout = current.layout;

  const latest = useRef({ layout, sourceKey, mirrorLocal, workspaceId });
  useEffect(() => {
    latest.current = { layout, sourceKey, mirrorLocal, workspaceId };
  });

  // Without a saved view, pick up this browser's last layout once mounted (the server render can't see it).
  useEffect(() => {
    if (!mirrorLocal) return;
    const local = readLocal(workspaceId);
    // Reading an external store (localStorage) that the server render could not see: the one legitimate setState-in-effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (local) setState({ sourceKey, layout: local });
  }, [mirrorLocal, workspaceId, sourceKey]);

  const update = useCallback((transition: (layout: BoardLayout) => BoardLayout) => {
    const { layout: before, sourceKey: key, mirrorLocal: mirror, workspaceId: id } = latest.current;
    const next = transition(before);
    if (next === before) return;
    latest.current = { ...latest.current, layout: next };
    setState({ sourceKey: key, layout: next });
    if (mirror) writeLocal(id, next);
  }, []);

  const stored = useMemo(() => serializeRoadmapBoardLayout(layout), [layout]);
  return useMemo(() => ({ layout: resolveRoadmapBoardLayout(layout), update, stored }), [layout, update, stored]);
}

export function RoadmapColumnLayoutProvider({
  workspaceId,
  savedView,
  children,
}: {
  workspaceId: string;
  /** The selected saved view, if any. `version` changes when the view is saved, which resets the layout to what was saved. */
  savedView: { id: string; version: string; columnLayout: unknown } | null;
  children: ReactNode;
}) {
  const controller = useColumnLayoutStore({
    workspaceId,
    sourceKey: savedView ? `${savedView.id}:${savedView.version}` : "none",
    initial: savedView?.columnLayout,
    mirrorLocal: savedView === null,
  });
  return <ColumnLayoutContext.Provider value={controller}>{children}</ColumnLayoutContext.Provider>;
}

/** For the saved-views menu: the live layout to save, or null outside a provider (then it saves nothing about layout). */
export function useRoadmapColumnLayoutContext(): ColumnLayoutController | null {
  return useContext(ColumnLayoutContext);
}

/**
 * For the board: the provider's controller, or (rendered without one, e.g. in a test or a surface that has no saved
 * views) a standalone store that still mirrors to this browser's localStorage.
 */
export function useRoadmapColumnLayout(workspaceId: string): ColumnLayoutController {
  const fromContext = useContext(ColumnLayoutContext);
  const standalone = useColumnLayoutStore({ workspaceId, sourceKey: "standalone", initial: undefined, mirrorLocal: fromContext === null });
  return fromContext ?? standalone;
}
