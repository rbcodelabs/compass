import type { GridActionResult, GridCellValue } from "@/components/data-grid";

/**
 * Saves one field of an entity through the endpoint the detail panels use
 * (`PATCH /api/panels/entity/:type/:id`, see lib/entity-mutations.ts), so
 * validation, workspace scoping, update capture and (for a Solution's status or
 * title) roadmap sync are exactly what an edit from the panel gets. Client-side
 * only. Resolves, never rejects: the grid rolls the cell back on `ok: false`.
 */
export async function savePanelEntityField(
  type: "opportunity" | "solution",
  slugs: { orgSlug: string; workspaceSlug: string },
  id: string,
  field: string,
  value: GridCellValue,
): Promise<GridActionResult> {
  try {
    const response = await fetch(
      `/api/panels/entity/${type}/${encodeURIComponent(id)}?orgSlug=${encodeURIComponent(slugs.orgSlug)}&workspaceSlug=${encodeURIComponent(slugs.workspaceSlug)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field, value }),
      },
    );
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: body?.error ?? "Couldn't save that change." };
  } catch {
    return { ok: false, error: "Couldn't save that change." };
  }
}
