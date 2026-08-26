"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";

/**
 * One place for "read the current search params, change some of them, push the
 * new URL".
 *
 * This block was previously duplicated verbatim in
 * `components/tasks/assignee-filter-bar.tsx`,
 * `components/tasks/tasks-view-toggle.tsx` and
 * `components/roadmap/roadmap-view-toggle.tsx`, each with its own subtly
 * different handling of the empty-query case and none of them wrapping the
 * push in a transition.
 *
 * Behaviour:
 *  - `null`, `undefined` and `""` **delete** a key. A filter that is cleared
 *    should leave no trace in the URL.
 *  - An empty result pushes the bare pathname, never a dangling `"?"`.
 *  - Pushes run inside `startTransition` with `{ scroll: false }`, so changing
 *    a filter neither jumps the viewport to the top nor blocks the UI.
 */

/** A value assignable to a search param. Nullish and `""` mean "remove it". */
export type UrlStateValue = string | number | boolean | null | undefined;

/** A partial update: `{ status: "OPEN", page: null }`. */
export type UrlStatePatch = Record<string, UrlStateValue>;

export type UrlState = {
  /** The live search params, as Next reports them. */
  params: URLSearchParams;
  /** Apply a partial update and push the resulting URL. */
  set: (patch: UrlStatePatch) => void;
  /** Remove the named keys, or every key when called with no argument. */
  clear: (keys?: readonly string[]) => void;
  /** Replace the entire query string with a pre-built set of params. */
  setAll: (next: URLSearchParams) => void;
  /** True while the pushed navigation is in flight. */
  isPending: boolean;
};

export function useUrlState(): UrlState {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const push = useCallback(
    (next: URLSearchParams) => {
      const query = next.toString();
      const href = query ? `${pathname}?${query}` : pathname;
      startTransition(() => {
        router.push(href, { scroll: false });
      });
    },
    [pathname, router],
  );

  const setAll = useCallback(
    (next: URLSearchParams) => {
      push(new URLSearchParams(next.toString()));
    },
    [push],
  );

  const set = useCallback(
    (patch: UrlStatePatch) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined || value === "") {
          next.delete(key);
        } else {
          next.set(key, String(value));
        }
      }
      push(next);
    },
    [push, searchParams],
  );

  const clear = useCallback(
    (keys?: readonly string[]) => {
      if (!keys) {
        push(new URLSearchParams());
        return;
      }
      const next = new URLSearchParams(searchParams.toString());
      for (const key of keys) next.delete(key);
      push(next);
    },
    [push, searchParams],
  );

  return { params: searchParams, set, clear, setAll, isPending };
}
