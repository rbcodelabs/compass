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
import type { CardEntityType } from "@/lib/spec-docs/card-edit";

export type EmbedEntry = { status: "ready"; card: DocEmbedCardView } | { status: "error" };
/** A resolution plus, from the server, whether the viewer may edit records in the doc's workspace (decides only what the cards offer). */
export type EmbedBatch = DocEmbedResolution & { canEdit?: boolean };
export type EmbedResolver = (refs: DocEmbedRef[]) => Promise<EmbedBatch>;

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
  private canEditValue = false;
  /** Per reference: the newest refresh() issued, so an older answer can never overwrite a newer one. */
  private refreshSeq = new Map<string, number>();

  constructor(private readonly resolver: EmbedResolver) {}

  /** Whether the server said this viewer may edit records. False until the first answer, and after any answer that does not say so. */
  canEdit = () => this.canEditValue;

  /**
   * Re-resolve one card from the server, bypassing the cache, after a write. The newest call for a reference wins. On failure the cached
   * card is kept (it is the last thing the server told us) and the error is rethrown for the caller to report.
   */
  async refresh(ref: DocEmbedRef): Promise<void> {
    const key = keyOf(ref);
    const seq = (this.refreshSeq.get(key) ?? 0) + 1;
    this.refreshSeq.set(key, seq);
    const result = await this.resolver([{ kind: ref.kind, id: ref.id.toLowerCase() }]);
    if (this.disposed || this.refreshSeq.get(key) !== seq) return;
    const card = result.cards[key];
    if (!card) throw new Error("Could not refresh the card");
    this.entries.set(key, { status: "ready", card });
    this.canEditValue = result.canEdit === true;
    this.notify();
  }

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
      this.canEditValue = result.canEdit === true;
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

/** Writes one field of a record: the same call the record's own detail panel makes (patchEntityField). Throws on any refusal. */
export type PatchRecordField = (type: CardEntityType, id: string, field: "title" | "status", value: string) => Promise<unknown>;

/**
 * What the cards in this editor may do. `editable` is the PAGE's answer (false for an org-wide read-only member); the server's per-batch
 * `canEdit` must also be true before any control shows. `patch` is how a record write is made.
 */
export type EmbedEditing = { editable: boolean; patch: PatchRecordField };
const EditingContext = createContext<EmbedEditing | null>(null);

/** Wrap the editor. `resolve` is read once, so pass a stable function (the doc id never changes for a mounted editor). */
export function DocEmbedCardsProvider({ resolve, editing, children }: { resolve: EmbedResolver; editing?: EmbedEditing; children: ReactNode }) {
  const [store] = useState(() => new EmbedCardStore(resolve));
  useEffect(() => {
    store.attach();
    return () => store.dispose();
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <EditingContext.Provider value={editing ?? null}>{children}</EditingContext.Provider>
    </StoreContext.Provider>
  );
}

/** The store, and whether edit controls may show at all (page editable AND the server said the viewer can write). Fails closed. */
export function useEmbedEditing(): { store: EmbedCardStore | null; canEdit: boolean; patch: PatchRecordField | null } {
  const store = useContext(StoreContext);
  const editing = useContext(EditingContext);
  const serverCanEdit = useSyncExternalStore(
    useCallback((listener: () => void) => (store ? store.subscribe(listener) : () => {}), [store]),
    () => store?.canEdit() ?? false,
    () => false
  );
  return { store, canEdit: Boolean(editing?.editable && serverCanEdit), patch: editing?.patch ?? null };
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
