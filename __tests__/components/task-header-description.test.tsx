// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/app/[orgSlug]/[workspaceSlug]/tasks/actions", () => ({
  moveTaskStatus: vi.fn(),
  updateTask: vi.fn(),
}));

// SquadPicker (rendered when squads.length > 0, but imported regardless)
// pulls in the settings actions module, which imports "@/auth" (next-auth) —
// mock it so the test doesn't need a real auth/session setup.
vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/actions", () => ({
  assignSquad: vi.fn(),
}));

import { TaskHeader } from "@/components/tasks/task-header";
import type { TaskCardData } from "@/components/tasks/task-card";

const baseTask: TaskCardData = {
  id: "task-1",
  title: "Ship the thing",
  description: null,
  status: "TODO",
  priority: "MEDIUM",
  sortOrder: 0,
  squadId: null,
  squad: null,
  assigneeUserId: null,
  ownerName: null,
  storyPoints: null,
  dueDate: null,
  iteration: null,
  parentTaskId: null,
  subtaskCount: 0,
  links: [],
};

function renderHeader(description: string | null) {
  return render(
    <TaskHeader
      task={{ ...baseTask, description }}
      workspaceId="ws-1"
      squads={[]}
      members={[]}
      revalidatePathStr="/rbcodelabs/compass/tasks/task-1"
    />
  );
}

describe("TaskHeader description rendering", () => {
  afterEach(() => cleanup());

  it("shows the empty state when there is no description", () => {
    renderHeader(null);
    expect(screen.getByText("No description yet.")).toBeInTheDocument();
  });

  it("renders a multi-paragraph description as distinct paragraphs", () => {
    renderHeader("First paragraph.\n\nSecond paragraph.");

    const paragraphs = screen.getAllByText(/paragraph\./);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].tagName).toBe("P");
    expect(paragraphs[1].tagName).toBe("P");
  });

  it("renders basic markdown emphasis as real elements", () => {
    renderHeader("This is **important** context.");

    const strong = screen.getByText("important");
    expect(strong.tagName).toBe("STRONG");
  });
});
