import { beforeEach, describe, expect, it, vi } from "vitest";

const undo = vi.hoisted(() => vi.fn());
vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({ undoRoadmapCreate: undo }));

import { announceRoadmapSync } from "@/lib/ui/roadmap-sync-toast";
import { getUndoToasts, resetUndoToasts } from "@/lib/ui/undo-toast";

beforeEach(() => { resetUndoToasts(); undo.mockReset(); });

describe("announceRoadmapSync", () => {
  it("does nothing when nothing was auto-added", () => {
    announceRoadmapSync(undefined);
    announceRoadmapSync(null);
    announceRoadmapSync({ autoAdded: null });
    expect(getUndoToasts()).toHaveLength(0);
  });

  it("tells the user the solution was auto-added and Undo archives only the new roadmap item", async () => {
    announceRoadmapSync({ autoAdded: { itemId: "item-1", workspaceId: "ws-1", title: "Adoption dashboard", start: "2026-10-05", end: "2026-11-15" } });
    const [toast] = getUndoToasts();
    expect(toast).toMatchObject({ message: "Auto-added “Adoption dashboard” to the roadmap", tone: "auto", actionLabel: "Undo" });
    await toast.onAction?.();
    expect(undo).toHaveBeenCalledWith("ws-1", ["item-1"]);
  });
});
