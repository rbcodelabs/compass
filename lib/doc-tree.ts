import type { DocTreeItem } from "@/components/docs/doc-tree-sidebar";

/**
 * Nest a flat doc list by `parentId`, ordered by `sortOrder`.
 *
 * Shared by the Docs route layout (server-rendered Library) and the agent
 * rail's Library view (via /api/docs-tree), so the two cannot disagree about
 * what the tree looks like. A doc whose parent is missing is promoted to a root.
 */
export function buildDocTree(
  docs: Array<{
    id: string;
    title: string;
    icon: string | null;
    parentId: string | null;
    sortOrder: number;
    docType?: string;
  }>,
): DocTreeItem[] {
  const sorted = [...docs].sort((a, b) => a.sortOrder - b.sortOrder);
  const map = new Map<string, DocTreeItem>();

  for (const doc of sorted) {
    map.set(doc.id, { ...doc, children: [] });
  }

  const roots: DocTreeItem[] = [];
  for (const doc of sorted) {
    const node = map.get(doc.id)!;
    if (doc.parentId && map.has(doc.parentId)) {
      map.get(doc.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
