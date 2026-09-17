// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type FunctionComponent } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelProvider } from "@/components/panels/panel-context";
/**
 * eslint's `react/no-children-prop` requires children to be passed as a
 * `createElement` argument, but TS's `createElement` overloads require
 * `children` *inside* the props object when the component declares it
 * required. Narrowing a provider to its non-children props satisfies both.
 */
type ProviderShell = FunctionComponent<{ orgSlug: string; workspaceSlug: string }>;
import type { TaskCardData } from "@/components/tasks/task-card";
import type { MemberData } from "@/lib/types";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

afterEach(cleanup);

// The tasks server-actions module transitively imports next-auth — mock the
// boundary so EditTaskDialog, TaskAssigneePicker, and TaskBoard render
// without a real auth/db stack.
vi.mock("@/app/[orgSlug]/[workspaceSlug]/tasks/actions", () => ({
  getTaskAssigneeOptions: vi.fn(),
  updateTask: vi.fn(),
  moveTaskStatus: vi.fn(),
  updateSortOrder: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  // PanelProvider (wrapped around TaskBoard below) reads the router and URL.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/rbcodelabs/compass/tasks",
  useSearchParams: () => new URLSearchParams(),
}));

function makeTask(overrides: Partial<TaskCardData> = {}): TaskCardData {
  return {
    id: "task-1",
    title: "Ship the thing",
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
    ...overrides,
  };
}

const members: MemberData[] = [
  { id: "m1", userId: "user-1", email: "ada@example.com", name: "Ada Lovelace, Very Long Display Name For Wrapping", role: "MEMBER" },
];

describe("Tasks dashboard workspace layout", () => {
  it("keeps long assignee labels inside the inline field and wraps menu choices", async () => {
    const { InlineAssigneeField } = await import("@/components/tasks/inline-assignee-field");
    render(
      createElement(InlineAssigneeField, {
        assigneeUserId: null,
        assigneeAgentId: null,
        current: null,
        ownerName: null,
        members,
        edit: {
          type: "task" as const,
          id: "task-1",
          orgSlug: "rbcodelabs",
          workspaceSlug: "compass",
          onSaved: vi.fn(),
        },
      }),
    );

    // The inline field stacks the picker above the freeform owner-name input
    // and must not let either overflow its column.
    const trigger = screen.getByLabelText("Assignee");
    expect(trigger.className).toContain("w-full min-w-0 [&>[data-slot=combobox-value]]:block");
    expect(trigger.closest("div")!.className).toContain("flex min-w-0 flex-col gap-1");

    const value = trigger.querySelector(String.raw`[data-slot="combobox-value"]`)!;
    expect(value.className).toContain("min-w-0 truncate");

    // The assignee picker actually rendered and wraps its long labels rather
    // than overflowing.
    fireEvent.click(trigger);
    const popup = await screen.findByPlaceholderText("Search people and agents…");
    const content = popup.closest(String.raw`[data-slot="combobox-content"]`)!;
    expect(content.className).toContain("[&_[data-slot=combobox-item]>span:first-child]:whitespace-normal");
    expect(content.className).toContain("[&_[data-slot=combobox-item]>span:first-child]:[overflow-wrap:anywhere]");
    expect(await screen.findByRole("option", { name: /Ada Lovelace/ })).toBeInTheDocument();
  });

  it("makes the board the sole horizontal scroller with inset track and independently scrolling columns", async () => {
    vi.doMock("@/components/tasks/task-card", () => ({ TaskCard: () => null }));
    vi.doMock("@/components/tasks/add-task-form", () => ({ AddTaskForm: () => null }));

    const { TaskBoard } = await import("@/components/tasks/task-board");
    const { container } = render(
      // TaskBoard subscribes to panel mutations (subscribeEntityMutated), so it
      // needs a PanelProvider the same way the other board tests do.
      createElement(
        PanelProvider as ProviderShell,
        { orgSlug: "rbcodelabs", workspaceSlug: "compass" },
        createElement(TaskBoard, {
          initialTasks: [],
          workspaceId: "workspace-1",
          orgSlug: "rbcodelabs",
          workspaceSlug: "compass",
          members: [],
        }),
      ),
    );

    const boardRegion = screen.getByRole("region", { name: "Task board" });
    expect(boardRegion.className).toContain("scroll-px-3");
    expect(boardRegion.className).toContain("sm:scroll-px-4");

    const track = container.querySelector('[data-slot="task-board-track"]')!;
    expect(track.className.startsWith("flex h-full w-max min-w-full")).toBe(true);
    expect(track.className).toContain("px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3");

    const column = container.querySelector('[data-task-column="TODO"]')!;
    expect(column.className).toContain('min-w-[280px] flex-1 overflow-hidden md:h-full');

    const columnBody = container.querySelector("#task-column-TODO")!;
    expect(columnBody.className).toContain("md:max-h-none");
    expect(columnBody.className).toContain("md:overflow-y-auto");

    vi.doUnmock("@/components/tasks/task-card");
    vi.doUnmock("@/components/tasks/add-task-form");
  }, 20000);

  // TODO(test-debt): still a source-text check, not a real render — page.tsx Server Components (auth/prisma/notFound) have no test-execution precedent in this repo yet. See Compass test-suite audit 2026-09-12 and the readFileSync anti-pattern finding. Do not treat this as verified behavior.
  describe("tasks page wiring (source-text check only, not a real render)", () => {
    it("uses the compact workspace shell and puts filters beside the view toggle", () => {
      const page = source("app/[orgSlug]/[workspaceSlug]/tasks/page.tsx");

      expect(page).toContain("<WorkspacePage");
      // Mounted with `squads` and `members`; extra props are allowed.
      expect(page).toMatch(/<TasksFilters\b[^>]*\bsquads=\{squads\}[^>]*\bmembers=\{members\}/);
      expect(page).toContain("<TasksViewToggle view={view} />");
      expect(page).toContain('contentClassName={view === "board" ? "p-0 sm:p-0 md:p-0" : undefined}');
      expect(page).not.toContain("PageHeader");
      expect(page).not.toContain("SquadFilterBar");
      expect(page).not.toContain("AssigneeFilterBar");
      expect(page).not.toContain("PriorityFilterBar");
      expect(page).not.toContain("Drag tasks between columns");
      expect(page).not.toContain('className="overflow-x-auto min-w-0"');
    });

    it("bulk-loads task relations while retaining workspace and facet filters", () => {
      const page = source("app/[orgSlug]/[workspaceSlug]/tasks/page.tsx");

      expect(page).toContain("workspaceId: workspace.id");
      expect(page).toContain("...(squadFilter ? { squadId: squadFilter } : {})");
      expect(page).toContain("...parseAssigneeFilter(assigneeFilter)");
      expect(page).toContain("...(priorityFilter ? { priority: priorityFilter } : {})");
      expect(page).toContain("prisma.taskLink.findMany({ where: { taskId: { in: taskIds } }");
      expect(page).toContain("prisma.task.groupBy({");
      expect(page).not.toContain("_count: { select: { subtasks: true } }");
    });
  });
});
