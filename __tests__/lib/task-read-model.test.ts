import { describe, expect, it } from "vitest";

import { buildTaskCards } from "@/lib/task-read-model";

describe("buildTaskCards", () => {
  it("joins squads, links, linked titles, and subtask counts without changing the card shape", () => {
    const cards = buildTaskCards({
      tasks: [{
        id: "task-1", title: "Ship", description: null, status: "TODO", priority: "HIGH",
        sortOrder: 2, squadId: "squad-1", assigneeUserId: null, ownerName: "Rick",
        storyPoints: 3, dueDate: new Date("2026-09-04T00:00:00.000Z"), iteration: null,
        parentTaskId: null,
      }],
      squads: [{ id: "squad-1", name: "Core", color: "blue" }],
      links: [
        { id: "link-1", taskId: "task-1", linkedType: "ROADMAP_ITEM", linkedId: "roadmap-1" },
        { id: "link-2", taskId: "task-1", linkedType: "SOLUTION", linkedId: "deleted" },
      ],
      subtaskCounts: [{ parentTaskId: "task-1", _count: { _all: 2 } }],
      linkedTitles: new Map([["ROADMAP_ITEM:roadmap-1", "Roadmap win"]]),
    });

    expect(cards).toEqual([expect.objectContaining({
      id: "task-1",
      squad: { id: "squad-1", name: "Core", color: "blue" },
      dueDate: "2026-09-04T00:00:00.000Z",
      subtaskCount: 2,
      links: [
        expect.objectContaining({ linkedTitle: "Roadmap win" }),
        expect.objectContaining({ linkedTitle: "(deleted)" }),
      ],
    })]);
  });

  it("handles tasks with no squad, links, or subtasks", () => {
    const [card] = buildTaskCards({
      tasks: [{
        id: "task-2", title: "Empty", description: null, status: "BACKLOG", priority: "LOW",
        sortOrder: 0, squadId: null, assigneeUserId: null, ownerName: null,
        storyPoints: null, dueDate: null, iteration: null, parentTaskId: null,
      }],
      squads: [], links: [], subtaskCounts: [], linkedTitles: new Map(),
    });

    expect(card).toEqual(expect.objectContaining({ squad: null, links: [], subtaskCount: 0 }));
  });
});
