import { pushUndoToast } from "@/lib/ui/undo-toast";
import type { SolutionSyncResult } from "@/lib/roadmap/solution-sync";

type AutoAdded = NonNullable<SolutionSyncResult["autoAdded"]>;

/**
 * When a solution moved to Building and Building auto-sync added it to the
 * roadmap, tell the person who made the change and offer Undo. Undo archives
 * the new roadmap item only: the solution keeps its status and returns to the
 * "Ready to schedule" rail, and auto-sync will not add it again.
 */
export function announceRoadmapSync(sync: { autoAdded?: AutoAdded | null } | null | undefined): void {
  const added = sync?.autoAdded;
  if (!added) return;
  pushUndoToast({
    message: `Auto-added “${added.title}” to the roadmap`,
    tone: "auto",
    actionLabel: "Undo",
    onAction: async () => {
      // Loaded on demand: this helper is imported by many client components that never undo.
      const { undoRoadmapCreate } = await import("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions");
      await undoRoadmapCreate(added.workspaceId, [added.itemId]);
    },
  });
}
