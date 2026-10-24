export type SaveToken = { expectedRevision?: string; operationId: string };
export function createDocumentSaveQueue<T>(options: {
  revision?: string | null;
  execute: (change: T, token: SaveToken) => Promise<{ revision?: string | null }>;
  onState: (state: "saving" | "saved" | "error", error?: unknown) => void;
  operationId?: () => string;
}) {
  let revision = options.revision ?? undefined;
  // Every revision this queue has held. A refresh that hands back one of these is our own (or an older) state, never news.
  const seen = new Set<string>(revision ? [revision] : []);
  let running = false;
  let failed = false;
  const pending: Array<{ change: T; token?: SaveToken; resolve: () => void; reject: (error: unknown) => void }> = [];
  function hold(next: string | undefined) {
    revision = next;
    if (next) seen.add(next);
  }
  async function drain() {
    if (running || failed) return;
    running = true;
    options.onState("saving");
    try {
      while (pending.length) {
        const item = pending[0];
        item.token ??= { expectedRevision: revision, operationId: (options.operationId ?? (() => crypto.randomUUID()))() };
        try {
          const result = await options.execute(item.change, item.token);
          hold(result.revision ?? revision);
          pending.shift();
          item.resolve();
        } catch (error) {
          failed = true;
          item.reject(error);
          options.onState("error", error);
          return;
        }
      }
      options.onState("saved");
    } finally { running = false; }
  }
  return {
    enqueue(change: T): Promise<void> {
      const result = new Promise<void>((resolve, reject) => { pending.push({ change, resolve, reject }); });
      void drain();
      return result;
    },
    async retry() { failed = false; await drain(); },
    /** True while anything is queued, in flight, or parked after a failure: the editor holds a draft the server has not seen. */
    pending: () => pending.length > 0,
    revision: () => revision,
    /** Whether `candidate` is a revision this queue already held, i.e. a refresh carrying it adds nothing new. */
    hasSeen: (candidate: string | null | undefined) => !!candidate && seen.has(candidate),
    /** A clean editor adopted the server's newer revision; later saves expect it. */
    setRevision(next: string | null | undefined) { if (next) hold(next); },
    /**
     * Keep-mine: someone else moved the document on and the user chose to overwrite. The queued work (including a save that failed with
     * a revision conflict) is re-based on `next` with a fresh token, so the retry no longer replays the stale one, then drained.
     */
    async rebase(next: string | null | undefined) {
      if (next) hold(next);
      for (const item of pending) if (item !== pending[0] || !running) item.token = undefined;
      failed = false;
      await drain();
    },
    /**
     * Reload: drop the local draft and expect `next`. Work not yet sent is discarded (resolved, not rejected, so no caller sees an
     * unhandled failure); a save already on the wire cannot be recalled and finishes normally.
     */
    discard(next: string | null | undefined) {
      const keep = running ? pending.slice(0, 1) : [];
      for (const item of pending.splice(keep.length)) item.resolve();
      failed = false;
      if (next) hold(next);
    },
  };
}
