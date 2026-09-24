export interface UpdateItem {
  id: string;
  revision: number;
  entityType: string;
  entityId: string;
  groupType: string;
  groupId: string;
  kind: string;
  before: string | null;
  after: string | null;
  title: string;
  groupTitle: string;
  href: string;
  groupHref: string;
  actor: string;
  createdAt: string;
}

export function groupUpdates(
  items: UpdateItem[],
): { id: string; items: UpdateItem[] }[] {
  const groups = new Map<string, UpdateItem[]>();
  const seen = new Set<string>();
  for (const item of [...items].sort((a, b) => b.revision - a.revision)) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const key = `${item.groupType}:${item.groupId}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups].map(([id, items]) => ({ id, items }));
}
export function updateHeadline(item: UpdateItem): string {
  const entity = item.entityType.toLowerCase().replaceAll("_", " ");
  const label = entity.charAt(0).toUpperCase() + entity.slice(1);
  const state = item.after?.toLowerCase().replaceAll("_", " ");
  if (item.kind === "STATUS_CHANGED")
    return `${label} ${item.after === "DONE" ? "marked done" : `moved to ${state}`}`;
  const actions: Record<string, string> = {
    CREATED: "created",
    EVIDENCE_ADDED: "New evidence added",
    RESULT_ADDED: "Experiment result recorded",
    DECISION_RECORDED: "Decision recorded",
    COMMENT_ADDED: "Discussion started",
    PLAN_PROPOSED: "Plan proposed",
  };
  return item.kind === "CREATED"
    ? `${label} created`
    : (actions[item.kind] ?? "Work updated");
}
