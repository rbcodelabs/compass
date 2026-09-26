export type SaveToken = { expectedRevision?: string; operationId: string };
export function createDocumentSaveQueue<T>(options: {
  revision?: string | null;
  execute: (change: T, token: SaveToken) => Promise<{ revision?: string | null }>;
  onState: (state: "saving" | "saved" | "error", error?: unknown) => void;
  operationId?: () => string;
}) {
  let revision = options.revision ?? undefined;
  let running = false;
  let failed = false;
  const pending: Array<{ change: T; token?: SaveToken; resolve: () => void; reject: (error: unknown) => void }> = [];
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
          revision = result.revision ?? revision;
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
    pending: () => pending.length > 0,
  };
}
