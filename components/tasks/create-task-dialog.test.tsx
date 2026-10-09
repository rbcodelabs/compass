// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const refresh = vi.hoisted(() => vi.fn());
const addTask = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/tasks/actions", () => ({ addTask }));

import { CreateTaskDialog } from "./create-task-dialog";
import { TASK_CREATED_EVENT } from "@/lib/task-created-event";

const created = {
  id: "task-1",
  title: "Write the guide",
  description: null,
  status: "TODO",
  priority: "MEDIUM",
  sortOrder: 1,
  assigneeUserId: null,
  assigneeAgentId: null,
  assignee: null,
  ownerName: null,
  storyPoints: null,
  dueDate: null,
  iteration: null,
  parentTaskId: null,
};

function renderDialog() {
  return render(<CreateTaskDialog workspaceId="ws-1" orgSlug="acme" workspaceSlug="growth" members={[]} />);
}

async function openAndType(title: string) {
  fireEvent.click(screen.getByRole("button", { name: "New task" }));
  const input = await screen.findByLabelText("Title");
  fireEvent.change(input, { target: { value: title } });
  return input;
}

beforeEach(() => {
  refresh.mockReset();
  addTask.mockReset();
});
afterEach(cleanup);

describe("CreateTaskDialog", () => {
  it("creates the task, announces it to the board, refreshes, and closes", async () => {
    addTask.mockResolvedValue(created);
    const listener = vi.fn();
    window.addEventListener(TASK_CREATED_EVENT, listener);
    renderDialog();
    await openAndType("  Write the guide ");
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    await waitFor(() => expect(addTask).toHaveBeenCalledTimes(1));
    expect(addTask).toHaveBeenCalledWith("ws-1", { title: "Write the guide", status: "TODO", assignee: null }, "/acme/growth/tasks");
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ id: "task-1", title: "Write the guide", status: "TODO" });
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    window.removeEventListener(TASK_CREATED_EVENT, listener);
  });

  it("rejects a blank title without calling the server", async () => {
    renderDialog();
    await openAndType("   ");
    fireEvent.submit(screen.getByLabelText("Title").closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Title is required");
    expect(addTask).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and shows the error when the action fails", async () => {
    addTask.mockRejectedValue(new Error("Boom"));
    const listener = vi.fn();
    window.addEventListener(TASK_CREATED_EVENT, listener);
    renderDialog();
    await openAndType("Will fail");
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Boom");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(listener).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    window.removeEventListener(TASK_CREATED_EVENT, listener);
  });
});
