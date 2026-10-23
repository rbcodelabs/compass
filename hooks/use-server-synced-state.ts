"use client";

import { useState, type Dispatch, type SetStateAction } from "react";

/**
 * Local, optimistically-editable state that re-seeds from a server-provided
 * `source` whenever it changes (e.g. after `router.refresh()`).
 *
 * `useState(() => build(props))` alone seeds once and never follows the server,
 * so a card moved by another user or an agent would never appear. This follows
 * the server instead, but only while `busy` is false: during a drag or with a
 * local mutation in flight the incoming props may predate the user's change,
 * and adopting them would snap the card back. The adoption is deferred, not
 * dropped - once `busy` clears the next render sees the still-different source
 * and adopts it, by which point it includes the user's own write.
 *
 * `source` is compared by identity; Next hands a fresh object on every RSC
 * refresh, so an unchanged board is re-seeded with equal content (no visible
 * change). `generation` increments on each adoption so callers can tell a
 * server-driven change from their own optimistic updates.
 */
export function useServerSyncedState<Source, State>(
  source: Source,
  build: (source: Source) => State,
  busy: boolean,
): { state: State; setState: Dispatch<SetStateAction<State>>; generation: number } {
  const [state, setState] = useState<State>(() => build(source));
  const [syncedSource, setSyncedSource] = useState<Source>(source);
  const [generation, setGeneration] = useState(0);

  // Adjusting state during render is React's sanctioned way to derive state
  // from props; React re-renders immediately without committing the stale pass.
  if (syncedSource !== source && !busy) {
    setSyncedSource(source);
    setState(build(source));
    setGeneration((g) => g + 1);
  }

  return { state, setState, generation };
}
