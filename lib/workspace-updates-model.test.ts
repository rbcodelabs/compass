import { describe, expect, it } from "vitest";
import {
  groupUpdates,
  updateHeadline,
  type UpdateItem,
} from "./workspace-updates-model";

const item = (revision: number, groupId = "parent"): UpdateItem => ({
  id: `event-${revision}`,
  revision,
  entityType: "TASK",
  entityId: "child",
  groupType: "TASK",
  groupId,
  kind: "STATUS_CHANGED",
  before: "TODO",
  after: "IN_PROGRESS",
  title: "Improve setup",
  groupTitle: "Workspace setup",
  href: "/tasks/child",
  groupHref: "/tasks/parent",
  actor: "A teammate",
  createdAt: "2026-09-23T12:00:00Z",
});
describe("workspace catch-up stories", () => {
  it("groups only explicit groups, deduplicates events, and orders by latest revision", () => {
    const groups = groupUpdates([item(1), item(3, "other"), item(2), item(2)]);
    expect(groups.map((g) => g.id)).toEqual(["TASK:other", "TASK:parent"]);
    expect(groups[1].items.map((e) => e.revision)).toEqual([2, 1]);
  });
  it("describes the latest transition without calling completed tasks shipped", () => {
    expect(updateHeadline({ ...item(1), after: "DONE" })).toBe(
      "Task marked done",
    );
    expect(updateHeadline({ ...item(2), before: "DONE", after: "TODO" })).toBe(
      "Task moved to todo",
    );
  });
});
