// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

function setUpNavigation(initialQuery: string) {
  const push = vi.fn();
  // Force a fresh module graph so this test's mock (not a previous test's
  // stale useSearchParams closure) is what TasksFilters picks up below.
  vi.resetModules();
  vi.doMock("next/navigation", () => ({
    useRouter: () => ({ push }),
    usePathname: () => "/rbcodelabs/compass/tasks",
    useSearchParams: () => new URLSearchParams(initialQuery),
    useParams: () => ({}),
  }));
  // TasksFilters pulls in useTaskAssignees, which imports the tasks server
  // actions module (transitively next-auth) — mock the boundary so this
  // renders without a real auth/db stack. useParams above returns no
  // org/workspace slugs, so useTaskAssignees never actually calls this and
  // instead falls back to deriving options from the `members` prop directly.
  vi.doMock("@/lib/task-assignees-client", () => ({
    fetchTaskAssigneeOptions: vi.fn(),
  }));
  return push;
}

describe("Tasks faceted filters", () => {
  it("adapts squad, assignee, and priority to the shared filter menu and pushes the chosen value", async () => {
    const push = setUpNavigation("");
    const { TasksFilters } = await import("@/components/tasks/tasks-filters");

    const squads = [{ id: "squad-1", name: "Growth", color: "#00ff00" }];
    const members = [{ id: "m1", userId: "user-1", email: "a@b.com", name: "Ada", role: "MEMBER" as const }];

    render(createElement(TasksFilters, { squads, members }));

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(await screen.findByText("Squad")).toBeInTheDocument();
    expect(screen.getByText("Assignee")).toBeInTheDocument();
    expect(screen.getByText("Priority")).toBeInTheDocument();

    // Selecting the squad option really pushes a URL with squad=<id>, proving
    // the adapter wires the real setFilter("squad", ...) callback through to
    // the option, not just a source-text mention of the string.
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Growth" }));
    expect(push).toHaveBeenCalledTimes(1);
    const url = new URL(push.mock.calls[0][0], "http://example.test");
    expect(url.pathname).toBe("/rbcodelabs/compass/tasks");
    expect(url.searchParams.get("squad")).toBe("squad-1");

    vi.doUnmock("next/navigation");
  }, 20000);

  it("clears all three task filters atomically while preserving unrelated query parameters", async () => {
    const push = setUpNavigation("squad=squad-1&assignee=user:user-1&priority=HIGH&sort=oldest");
    const { TasksFilters } = await import("@/components/tasks/tasks-filters");

    const squads = [{ id: "squad-1", name: "Growth", color: "#00ff00" }];
    const members = [{ id: "m1", userId: "user-1", email: "a@b.com", name: "Ada", role: "MEMBER" as const }];

    render(createElement(TasksFilters, { squads, members }));

    // Three active filters (squad, assignee, priority) surface a "Clear all"
    // action on the shared menu.
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await screen.findByText("Clear all"));

    expect(push).toHaveBeenCalledTimes(1);
    const url = new URL(push.mock.calls[0][0], "http://example.test");
    expect(url.pathname).toBe("/rbcodelabs/compass/tasks");
    expect(url.searchParams.has("squad")).toBe(false);
    expect(url.searchParams.has("assignee")).toBe(false);
    expect(url.searchParams.has("priority")).toBe(false);
    // The unrelated "sort" parameter survives the clear.
    expect(url.searchParams.get("sort")).toBe("oldest");

    vi.doUnmock("next/navigation");
  }, 20000);
});
