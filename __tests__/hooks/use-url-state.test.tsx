// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const push = vi.fn();
let currentSearch = "";
let currentPath = "/acme/web/tasks";

vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => currentPath,
  useSearchParams: () => new URLSearchParams(currentSearch),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/tasks/actions", () => ({ getTaskAssigneeOptions: vi.fn() }));

import { useUrlState } from "@/hooks/use-url-state";
import {
  AssigneeFilterBar,
  PriorityFilterBar,
} from "@/components/tasks/assignee-filter-bar";
import { TasksViewToggle } from "@/components/tasks/tasks-view-toggle";
import { RoadmapViewToggle } from "@/components/roadmap/roadmap-view-toggle";

afterEach(cleanup);
beforeEach(() => {
  push.mockClear();
  currentSearch = "";
  currentPath = "/acme/web/tasks";
});

/** Last href pushed by the router. */
function lastPush(): string {
  expect(push).toHaveBeenCalled();
  return push.mock.calls[push.mock.calls.length - 1][0] as string;
}

function lastOptions(): unknown {
  return push.mock.calls[push.mock.calls.length - 1][1];
}

function Harness({ onReady }: { onReady: (state: ReturnType<typeof useUrlState>) => void }) {
  const state = useUrlState();
  return (
    <div>
      <button type="button" data-testid="run" onClick={() => onReady(state)}>
        run
      </button>
      <span data-testid="pending">{String(state.isPending)}</span>
      <span data-testid="params">{state.params.toString()}</span>
    </div>
  );
}

function run(onReady: (state: ReturnType<typeof useUrlState>) => void) {
  render(<Harness onReady={onReady} />);
  fireEvent.click(screen.getByTestId("run"));
}

describe("useUrlState", () => {
  it("exposes the live search params", () => {
    currentSearch = "assignee=u1&view=list";
    render(<Harness onReady={() => {}} />);
    expect(screen.getByTestId("params")).toHaveTextContent("assignee=u1&view=list");
    expect(screen.getByTestId("pending")).toHaveTextContent("false");
  });

  it("sets a value while preserving unrelated params", () => {
    currentSearch = "squad=s1&view=list";
    run((s) => s.set({ assignee: "u1" }));
    expect(lastPush()).toBe("/acme/web/tasks?squad=s1&view=list&assignee=u1");
  });

  it("pushes with { scroll: false } inside a transition", () => {
    run((s) => s.set({ assignee: "u1" }));
    expect(lastOptions()).toEqual({ scroll: false });
  });

  it("deletes a key for null, undefined and empty string", () => {
    for (const value of [null, undefined, ""] as const) {
      push.mockClear();
      currentSearch = "assignee=u1&squad=s1";
      cleanup();
      run((s) => s.set({ assignee: value }));
      expect(lastPush(), `value=${String(value)}`).toBe("/acme/web/tasks?squad=s1");
    }
  });

  it("pushes the bare pathname rather than a dangling '?' when nothing is left", () => {
    currentSearch = "assignee=u1";
    run((s) => s.set({ assignee: null }));
    expect(lastPush()).toBe("/acme/web/tasks");
    expect(lastPush()).not.toContain("?");
  });

  it("coerces numbers and booleans to strings", () => {
    run((s) => s.set({ page: 3, compact: true }));
    expect(lastPush()).toBe("/acme/web/tasks?page=3&compact=true");
  });

  it("applies a multi-key patch of sets and deletes in one push", () => {
    currentSearch = "page=5&status=OPEN&view=list";
    run((s) => s.set({ status: "PLANNED", page: null, q: "dark" }));
    expect(push).toHaveBeenCalledTimes(1);
    const url = new URL(lastPush(), "https://x.test");
    expect(url.searchParams.get("status")).toBe("PLANNED");
    expect(url.searchParams.get("page")).toBeNull();
    expect(url.searchParams.get("q")).toBe("dark");
    expect(url.searchParams.get("view")).toBe("list");
  });

  it("clear(keys) removes only the named keys", () => {
    currentSearch = "assignee=u1&squad=s1&view=list";
    run((s) => s.clear(["assignee", "squad"]));
    expect(lastPush()).toBe("/acme/web/tasks?view=list");
  });

  it("clear() with no argument removes everything", () => {
    currentSearch = "assignee=u1&squad=s1&view=list";
    run((s) => s.clear());
    expect(lastPush()).toBe("/acme/web/tasks");
  });

  it("setAll replaces the whole query string", () => {
    currentSearch = "assignee=u1&view=list";
    run((s) => s.setAll(new URLSearchParams("sort=votes&dir=desc")));
    expect(lastPush()).toBe("/acme/web/tasks?sort=votes&dir=desc");
  });

  it("setAll with empty params pushes the bare pathname", () => {
    currentSearch = "sort=votes";
    run((s) => s.setAll(new URLSearchParams()));
    expect(lastPush()).toBe("/acme/web/tasks");
  });

  it("uses the current pathname, whatever it is", () => {
    currentPath = "/acme/web/roadmap";
    run((s) => s.set({ view: "timeline" }));
    expect(lastPush()).toBe("/acme/web/roadmap?view=timeline");
  });
});

// ---------------------------------------------------------------------------
// The three refactored call sites must behave exactly as they did before.
// ---------------------------------------------------------------------------

const MEMBERS = [
  { userId: "u1", name: "Ada", email: "ada@x.test" },
  { userId: "u2", name: "", email: "bob@x.test" },
] as never;

describe("AssigneeFilterBar on useUrlState", () => {
  it("renders nothing without members", () => {
    const { container } = render(<AssigneeFilterBar members={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("sets ?assignee and preserves other params", () => {
    currentSearch = "squad=s1";
    render(<AssigneeFilterBar members={MEMBERS} />);
    fireEvent.click(screen.getByRole("button", { name: "Ada" }));
    expect(lastPush()).toBe("/acme/web/tasks?squad=s1&assignee=user%3Au1");
  });

  it("falls back to the email when a member has no name", () => {
    render(<AssigneeFilterBar members={MEMBERS} />);
    fireEvent.click(screen.getByRole("button", { name: "bob@x.test" }));
    expect(lastPush()).toBe("/acme/web/tasks?assignee=user%3Au2");
  });

  it("clicking the active assignee toggles it off", () => {
    currentSearch = "assignee=u1&squad=s1";
    render(<AssigneeFilterBar members={MEMBERS} />);
    fireEvent.click(screen.getByRole("button", { name: "Ada" }));
    expect(lastPush()).toBe("/acme/web/tasks?squad=s1");
  });

  it("'All' clears the assignee param", () => {
    currentSearch = "assignee=u1";
    render(<AssigneeFilterBar members={MEMBERS} />);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(lastPush()).toBe("/acme/web/tasks");
  });
});

describe("PriorityFilterBar on useUrlState", () => {
  it("sets and toggles ?priority", () => {
    render(<PriorityFilterBar />);
    // The pill is labelled "Urgent" but the param it writes stays the raw enum.
    fireEvent.click(screen.getByRole("button", { name: "Urgent" }));
    expect(lastPush()).toBe("/acme/web/tasks?priority=URGENT");

    cleanup();
    push.mockClear();
    currentSearch = "priority=HIGH&assignee=u1";
    render(<PriorityFilterBar />);
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    expect(lastPush()).toBe("/acme/web/tasks?assignee=u1");
  });
});

describe("TasksViewToggle on useUrlState", () => {
  it("sets ?view=list and drops the param for the default board view", () => {
    currentSearch = "assignee=u1";
    render(<TasksViewToggle view="board" />);
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    expect(lastPush()).toBe("/acme/web/tasks?assignee=u1&view=list");

    cleanup();
    push.mockClear();
    currentSearch = "view=list&assignee=u1";
    render(<TasksViewToggle view="list" />);
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(lastPush()).toBe("/acme/web/tasks?assignee=u1");
  });

  it("pushes a bare pathname when board is the only param", () => {
    currentSearch = "view=list";
    render(<TasksViewToggle view="list" />);
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(lastPush()).toBe("/acme/web/tasks");
  });
});

describe("RoadmapViewToggle on useUrlState", () => {
  it("sets ?view=timeline and drops the param for the default board view", () => {
    currentPath = "/acme/web/roadmap";
    currentSearch = "horizon=NOW";
    render(<RoadmapViewToggle view="board" />);
    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    expect(lastPush()).toBe("/acme/web/roadmap?horizon=NOW&view=timeline");

    cleanup();
    push.mockClear();
    currentSearch = "view=timeline&horizon=NOW";
    render(<RoadmapViewToggle view="timeline" />);
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(lastPush()).toBe("/acme/web/roadmap?horizon=NOW");
  });
});
