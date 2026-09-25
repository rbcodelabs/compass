// @vitest-environment jsdom
/**
 * Regression coverage for the agent-assignee capability that the
 * roadmap-delivery-tasks.tsx -> linked-tasks-section.tsx generalization
 * initially dropped: the "Add task" form must offer TaskAssigneePicker
 * (people AND agents), and the linked-task list must render the same
 * assignee fallback chain the old RoadmapDeliveryTasks component had
 * (resolved `assignee` first, then a raw `members` lookup, then an
 * "Unavailable assignee" marker, then `ownerName`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockAddLinkedTask, mockLinkExistingTask, mockNotifyEntityMutated } = vi.hoisted(() => ({
  mockAddLinkedTask: vi.fn(),
  mockLinkExistingTask: vi.fn(),
  mockNotifyEntityMutated: vi.fn(),
}));

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({
    openPanel: vi.fn(),
    notifyEntityMutated: mockNotifyEntityMutated,
    orgSlug: "acme",
    workspaceSlug: "product",
  }),
}));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/tasks/actions", () => ({
  addLinkedTask: mockAddLinkedTask,
  linkExistingTask: mockLinkExistingTask,
}));

// TaskAssigneePicker itself fetches workspace assignee options over the
// network (useTaskAssignees -> fetchTaskAssigneeOptions) and renders a Base UI
// combobox with no existing interaction-testing precedent in this suite.
// Stubbed here so the test asserts what matters: that LinkedTasksSection
// renders *this* component (agent+human capable), not a bare people-only
// Combobox, and that its onChange reaches addLinkedTask as `assignee`.
vi.mock("@/components/tasks/task-assignee-picker", () => ({
  TaskAssigneePicker: ({ onChange }: { onChange: (value: unknown) => void }) => (
    <button type="button" onClick={() => onChange({ type: "AGENT", id: "agent-1" })}>
      Assign an agent
    </button>
  ),
}));

import { LinkedTasksSection, type LinkedTaskData } from "@/components/tasks/linked-tasks-section";

const members = [
  { id: "m1", userId: "user-1", email: "alice@example.com", name: "Alice", role: "MEMBER" as const },
];

function baseTask(overrides: Partial<LinkedTaskData>): LinkedTaskData {
  return {
    id: "task-1",
    title: "Ship it",
    status: "TODO",
    priority: "MEDIUM",
    assigneeUserId: null,
    assigneeAgentId: null,
    assignee: null,
    ownerName: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAddLinkedTask.mockResolvedValue({ id: "task-new" });
});

afterEach(() => {
  cleanup();
});

describe("LinkedTasksSection — add-task form assignee capability", () => {
  it("renders TaskAssigneePicker (agent+human capable), not a plain people-only combobox", async () => {
    render(
      <LinkedTasksSection
        linkedType="ROADMAP_ITEM"
        linkedId="ri-1"
        orgSlug="acme"
        workspaceSlug="product"
        revalidatePathStr="/acme/product/roadmap"
        tasks={[]}
        linkableTasks={[]}
        members={members}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /add task/i }));
    expect(await screen.findByText("Assign an agent")).toBeInTheDocument();
  });

  it("forwards an agent assignee (not assigneeUserId) through to addLinkedTask", async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(
      <LinkedTasksSection
        linkedType="ROADMAP_ITEM"
        linkedId="ri-1"
        orgSlug="acme"
        workspaceSlug="product"
        revalidatePathStr="/acme/product/roadmap"
        tasks={[]}
        linkableTasks={[]}
        members={members}
        onChanged={onChanged}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /add task/i }));
    fireEvent.click(await screen.findByText("Assign an agent"));
    fireEvent.change(screen.getByLabelText(/task title/i), { target: { value: "Automate the thing" } });
    fireEvent.submit(screen.getByLabelText(/task title/i).closest("form")!);

    await vi.waitFor(() => expect(mockAddLinkedTask).toHaveBeenCalled());
    expect(mockAddLinkedTask).toHaveBeenCalledWith(
      "acme",
      "product",
      "ROADMAP_ITEM",
      "ri-1",
      { title: "Automate the thing", assignee: { type: "AGENT", id: "agent-1" } },
      "/acme/product/roadmap"
    );
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mockNotifyEntityMutated).toHaveBeenCalledWith("roadmapItem", "ri-1");
  });
});

describe("LinkedTasksSection — assignee display fallback chain", () => {
  it("shows 'Agent: <name>' for a resolved, available agent assignee", () => {
    render(
      <LinkedTasksSection
        linkedType="ROADMAP_ITEM"
        linkedId="ri-1"
        orgSlug="acme"
        workspaceSlug="product"
        revalidatePathStr="/acme/product/roadmap"
        tasks={[baseTask({ assigneeAgentId: "agent-1", assignee: { type: "AGENT", id: "agent-1", displayName: "Release Bot", available: true } })]}
        linkableTasks={[]}
        members={members}
        onChanged={vi.fn()}
      />
    );
    expect(screen.getByText("Agent: Release Bot")).toBeInTheDocument();
  });

  it("appends '(unavailable)' for a resolved but no-longer-available agent", () => {
    render(
      <LinkedTasksSection
        linkedType="ROADMAP_ITEM"
        linkedId="ri-1"
        orgSlug="acme"
        workspaceSlug="product"
        revalidatePathStr="/acme/product/roadmap"
        tasks={[baseTask({ assigneeAgentId: "agent-1", assignee: { type: "AGENT", id: "agent-1", displayName: "Retired Bot", available: false } })]}
        linkableTasks={[]}
        members={members}
        onChanged={vi.fn()}
      />
    );
    expect(screen.getByText("Agent: Retired Bot (unavailable)")).toBeInTheDocument();
  });

  it("falls back to the raw members lookup when no resolved assignee is present", () => {
    render(
      <LinkedTasksSection
        linkedType="ROADMAP_ITEM"
        linkedId="ri-1"
        orgSlug="acme"
        workspaceSlug="product"
        revalidatePathStr="/acme/product/roadmap"
        tasks={[baseTask({ assigneeUserId: "user-1" })]}
        linkableTasks={[]}
        members={members}
        onChanged={vi.fn()}
      />
    );
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("shows 'Unavailable assignee' when assigneeUserId/assigneeAgentId is set but unresolved and not in members", () => {
    render(
      <LinkedTasksSection
        linkedType="ROADMAP_ITEM"
        linkedId="ri-1"
        orgSlug="acme"
        workspaceSlug="product"
        revalidatePathStr="/acme/product/roadmap"
        tasks={[baseTask({ assigneeUserId: "removed-user" })]}
        linkableTasks={[]}
        members={members}
        onChanged={vi.fn()}
      />
    );
    expect(screen.getByText("Unavailable assignee")).toBeInTheDocument();
  });

  it("falls back to ownerName when there is no assignee at all", () => {
    render(
      <LinkedTasksSection
        linkedType="ROADMAP_ITEM"
        linkedId="ri-1"
        orgSlug="acme"
        workspaceSlug="product"
        revalidatePathStr="/acme/product/roadmap"
        tasks={[baseTask({ ownerName: "External Stakeholder" })]}
        linkableTasks={[]}
        members={members}
        onChanged={vi.fn()}
      />
    );
    expect(screen.getByText("External Stakeholder")).toBeInTheDocument();
  });
});
