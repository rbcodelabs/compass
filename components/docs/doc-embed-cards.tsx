"use client";
/**
 * Live data for the embed cards in one Doc (spec docs phase 3).
 *
 * Each card asks for its own reference when it comes near the viewport; requests made in the same moment are coalesced into one server
 * round trip, at most MAX_CARD_REFS per call. Results are cached for the life of the editor. The server decides what each reference is
 * (ok or unavailable) from the DOC's workspace: nothing on the client names a workspace.
 */
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { MAX_CARD_REFS } from "@/lib/canvas-cards";
import type { DocEmbedRef } from "@/lib/doc-embeds";
import type { DocEmbedCardView, DocEmbedResolution } from "@/lib/canvas-card-data";

export type EmbedEntry = { status: "ready"; card: DocEmbedCardView } | { status: "error" };
export type EmbedResolver = (refs: DocEmbedRef[]) => Promise<DocEmbedResolution>;

/** Requests that arrive within this window share one call. */
const BATCH_WINDOW_MS = 25;

const keyOf = (ref: DocEmbedRef) => `${ref.kind}:${ref.id.toLowerCase()}`;

export class EmbedCardStore {
  private entries = new Map<string, EmbedEntry>();
  private pending = new Map<string, DocEmbedRef>();
  private inflight = new Set<string>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly resolver: EmbedResolver) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Undefined until the first answer arrives (the card shows its loading state). */
  get(ref: DocEmbedRef): EmbedEntry | undefined {
    return this.entries.get(keyOf(ref));
  }

  /** Ask for a card's data. Idempotent; a failed earlier attempt is retried. */
  request(ref: DocEmbedRef) {
    const key = keyOf(ref);
    const known = this.entries.get(key);
    if (known?.status === "ready" || this.pending.has(key) || this.inflight.has(key)) return;
    this.pending.set(key, { kind: ref.kind, id: ref.id.toLowerCase() });
    this.schedule();
  }

  /** Called when the owning component mounts (and again after React's dev-mode remount). */
  attach() {
    this.disposed = false;
    if (this.pending.size > 0) this.schedule();
  }

  /** Stops timers and ignores answers that arrive after unmount. */
  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, BATCH_WINDOW_MS);
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }

  private async flush() {
    if (this.disposed) return;
    const batch = [...this.pending.values()].slice(0, MAX_CARD_REFS);
    for (const ref of batch) {
      this.pending.delete(keyOf(ref));
      this.inflight.add(keyOf(ref));
    }
    if (batch.length === 0) return;
    try {
      const result = await this.resolver(batch);
      for (const ref of batch) {
        const key = keyOf(ref);
        const card = result.cards[key];
        if (card) this.entries.set(key, { status: "ready", card });
        // Not answered and not deferred: treat as a failed load rather than leaving a spinner behind.
        else if (!result.deferred.some((d) => keyOf(d) === key)) this.entries.set(key, { status: "error" });
      }
      for (const ref of result.deferred) if (this.inflight.has(keyOf(ref))) this.pending.set(keyOf(ref), ref);
    } catch {
      for (const ref of batch) this.entries.set(keyOf(ref), { status: "error" });
    } finally {
      for (const ref of batch) this.inflight.delete(keyOf(ref));
    }
    if (this.disposed) return;
    this.notify();
    if (this.pending.size > 0) this.schedule();
  }
}

const StoreContext = createContext<EmbedCardStore | null>(null);

/** Wrap the editor. `resolve` is read once, so pass a stable function (the doc id never changes for a mounted editor). */
export function DocEmbedCardsProvider({ resolve, children }: { resolve: EmbedResolver; children: ReactNode }) {
  const [store] = useState(() => new EmbedCardStore(resolve));
  useEffect(() => {
    store.attach();
    return () => store.dispose();
  }, [store]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** The cached answer for one reference and a function that asks for it. Without a provider nothing is ever loaded. */
export function useEmbedEntry(ref: DocEmbedRef): { entry: EmbedEntry | undefined; request: () => void } {
  const store = useContext(StoreContext);
  const { kind, id } = ref;
  const entry = useSyncExternalStore(
    useCallback((listener: () => void) => (store ? store.subscribe(listener) : () => {}), [store]),
    () => store?.get({ kind, id }),
    () => undefined
  );
  const request = useCallback(() => store?.request({ kind, id }), [store, kind, id]);
  return { entry, request };
}

/** True once the element is within 200px of the viewport (or immediately when IntersectionObserver is unavailable). */
export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (near || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}
