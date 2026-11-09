// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@/app/[orgSlug]/[workspaceSlug]/tasks/actions", () => ({ cancelTask: vi.fn() }));
vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    setActivatorNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

let mockPanel: { type: string; id: string } | null = null;
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel: vi.fn(), panel: mockPanel }),
}));

import { TaskCard, type TaskCardData } from "./task-card";

function task(id: string, title: string): TaskCardData {
  return {
    id,
    title,
    description: null,
    status: "TODO",
    priority: "MEDIUM",
    sortOrder: 0,
    squadId: null,
    squad: null,
    assigneeUserId: null,
    assigneeAgentId: null,
    assignee: null,
    ownerName: null,
    storyPoints: null,
    dueDate: null,
    iteration: null,
    parentTaskId: null,
    subtaskCount: 0,
    links: [],
  } as TaskCardData;
}

function renderCard(t: TaskCardData) {
  return render(
    <TaskCard task={t} revalidatePathStr="/x" orgSlug="o" workspaceSlug="w" members={[]} onCancel={() => {}} />,
  );
}

afterEach(() => {
  cleanup();
  mockPanel = null;
});

describe("TaskCard active state", () => {
  it("marks the card whose task is open in the detail panel", () => {
    mockPanel = { type: "task", id: "a" };
    renderCard(task("a", "Open one"));
    const card = screen.getByText("Open one").closest("article")!;
    expect(card).toHaveAttribute("data-selected", "true");
    expect(card).toHaveAttribute("aria-current", "true");
  });

  it("does not mark a card for a different task or a different entity type", () => {
    mockPanel = { type: "task", id: "other" };
    renderCard(task("a", "Closed one"));
    let card = screen.getByText("Closed one").closest("article")!;
    expect(card).not.toHaveAttribute("data-selected");
    expect(card).not.toHaveAttribute("aria-current");
    cleanup();

    mockPanel = { type: "solution", id: "a" };
    renderCard(task("a", "Same id other type"));
    card = screen.getByText("Same id other type").closest("article")!;
    expect(card).not.toHaveAttribute("aria-current");
  });

  it("is not marked when no panel is open", () => {
    renderCard(task("a", "No panel"));
    expect(screen.getByText("No panel").closest("article")).not.toHaveAttribute("data-selected");
  });
});
