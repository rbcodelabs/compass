"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  parseBoardLayout,
  resolveBoardLayout,
  serializeBoardLayout,
  type BoardLayout,
  type BoardLayoutDefaults,
} from "@/lib/board-layout";

/**
 * A board's column layout (pinned / collapsed / order, see lib/board-layout.ts) as client state, for ANY board.
 *
 * Why a store and not a URL param: the layout is too noisy for the URL, but "Save" in a saved-views menu has to
 * capture it, and the menu (in the page header) and the board are siblings. The page wraps both in the Provider;
 * the board reads and changes the layout, the menu reads `stored` to save it and to tell whether the selected view
 * has been modified (it merges `stored` into the state Save captures and computes a separate `layoutModified`).
 *
 * Where the starting layout comes from:
 *   - a saved view is selected: that view's stored layout (absent = defaults). Changes stay in memory until saved.
 *     `sourceKey` identifies the view (and its version), so picking another view or saving this one resets the layout
 *     to the stored one, while a filter edit on the same view keeps it.
 *   - no saved view: the defaults, then whatever this browser last used for the scope (localStorage, parsed
 *     tolerantly), mirrored on every change. The localStorage read happens in an effect, so the server render and the
 *     first client render agree.
 *
 * Binding a second board takes one config and three exports:
 *
 * ```tsx
 * // components/tasks/task-layout.tsx
 * const tasks = createBoardLayout({
 *   columnIds: ["BACKLOG", "TODO", "DOING", "DONE"],            // every column, in default order
 *   defaults: { pinned: ["DONE"], active: "DONE" },              // omit for "nothing pinned"
 *   storageKey: (workspaceId) => `compass:tasks-column-layout:${workspaceId}`, // one key per scope
 * });
 * export const TasksLayoutProvider = tasks.Provider;             // <Provider scopeId savedView>{page header + board}</Provider>
 * export const useTasksLayoutContext = tasks.useContextController; // saved-views menu: controller | null
 * export const useTasksLayout = tasks.useBoardLayout;            // board: useTasksLayout(workspaceId)
 * ```
 */

export type BoardLayoutController = {
  /** The layout, resolved against the board's columns. */
  layout: BoardLayout;
  /** Apply a pure transition from lib/board-layout.ts. A no-op transition (same reference back) changes nothing. */
  update: (transition: (layout: BoardLayout) => BoardLayout) => void;
  /** The form to put in a saved view: `undefined` when it is the default. */
  stored: BoardLayout | undefined;
};

export type BoardLayoutConfig = {
  /** Every column id the board can show, in default order. */
  columnIds: readonly string[];
  /** Which columns start pinned, and how the dock starts. */
  defaults?: BoardLayoutDefaults;
  /** The localStorage key for a scope (a workspace id, say). Must differ per board and per scope. */
  storageKey: (scopeId: string) => string;
};

export type BoardSavedView = { id: string; version: string; columnLayout: unknown };

function readLocal(config: BoardLayoutConfig, scopeId: string): BoardLayout | null {
  try {
    const raw = window.localStorage.getItem(config.storageKey(scopeId));
    return raw ? parseBoardLayout(JSON.parse(raw), config.columnIds, config.defaults) : null;
  } catch {
    return null; // storage blocked, or the value isn't JSON: use the defaults
  }
}

function writeLocal(config: BoardLayoutConfig, scopeId: string, layout: BoardLayout) {
  try {
    const stored = serializeBoardLayout(layout, config.columnIds, config.defaults);
    if (stored) window.localStorage.setItem(config.storageKey(scopeId), JSON.stringify(stored));
    else window.localStorage.removeItem(config.storageKey(scopeId));
  } catch {
    // best effort: the layout still applies for this session
  }
}

export function useBoardLayoutStore(
  config: BoardLayoutConfig,
  { scopeId, sourceKey, initial, mirrorLocal }: { scopeId: string; sourceKey: string; initial: unknown; mirrorLocal: boolean },
): BoardLayoutController {
  const parse = useCallback((raw: unknown) => parseBoardLayout(raw, config.columnIds, config.defaults), [config]);
  const [state, setState] = useState(() => ({ sourceKey, layout: parse(initial) }));
  // A different saved view (or a new version of it) starts over from what it stored.
  const current = state.sourceKey === sourceKey ? state : { sourceKey, layout: parse(initial) };
  if (current !== state) setState(current);
  const layout = current.layout;

  const latest = useRef({ layout, sourceKey, mirrorLocal, scopeId });
  useEffect(() => {
    latest.current = { layout, sourceKey, mirrorLocal, scopeId };
  });

  // Without a saved view, pick up this browser's last layout once mounted (the server render can't see it).
  useEffect(() => {
    if (!mirrorLocal) return;
    const local = readLocal(config, scopeId);
    // Reading an external store (localStorage) that the server render could not see: the one legitimate setState-in-effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (local) setState({ sourceKey, layout: local });
  }, [config, mirrorLocal, scopeId, sourceKey]);

  const update = useCallback(
    (transition: (layout: BoardLayout) => BoardLayout) => {
      const { layout: before, sourceKey: key, mirrorLocal: mirror, scopeId: id } = latest.current;
      const next = transition(before);
      if (next === before) return;
      latest.current = { ...latest.current, layout: next };
      setState({ sourceKey: key, layout: next });
      if (mirror) writeLocal(config, id, next);
    },
    [config],
  );

  const stored = useMemo(() => serializeBoardLayout(layout, config.columnIds, config.defaults), [config, layout]);
  return useMemo(
    () => ({ layout: resolveBoardLayout(layout, config.columnIds, config.defaults), update, stored }),
    [config, layout, update, stored],
  );
}

/** Binds a board's layout config to its own context, provider and hooks. Call once at module level. */
export function createBoardLayout(config: BoardLayoutConfig) {
  const Context = createContext<BoardLayoutController | null>(null);

  function Provider({
    scopeId,
    savedView,
    children,
  }: {
    scopeId: string;
    /** The selected saved view, if any. `version` changes when the view is saved, which resets the layout to what was saved. */
    savedView: BoardSavedView | null;
    children: ReactNode;
  }) {
    const controller = useBoardLayoutStore(config, {
      scopeId,
      sourceKey: savedView ? `${savedView.id}:${savedView.version}` : "none",
      initial: savedView?.columnLayout,
      mirrorLocal: savedView === null,
    });
    return <Context.Provider value={controller}>{children}</Context.Provider>;
  }

  /** For the saved-views menu: the live layout to save, or null outside a provider (then it saves nothing about layout). */
  function useContextController(): BoardLayoutController | null {
    return useContext(Context);
  }

  /**
   * For the board: the provider's controller, or (rendered without one, e.g. in a test or a surface that has no saved
   * views) a standalone store that still mirrors to this browser's localStorage.
   */
  function useBoardLayout(scopeId: string): BoardLayoutController {
    const fromContext = useContext(Context);
    const standalone = useBoardLayoutStore(config, { scopeId, sourceKey: "standalone", initial: undefined, mirrorLocal: fromContext === null });
    return fromContext ?? standalone;
  }

  return { config, Provider, useContextController, useBoardLayout };
}
