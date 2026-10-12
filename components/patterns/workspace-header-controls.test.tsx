// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Columns3, List } from "lucide-react";
import { WorkspaceCreateButton, WorkspaceIconButton, WorkspaceMoreMenu, WorkspaceViewSwitcher } from "./workspace-header-controls";
import { WorkspaceHeader } from "./workspace-page";

afterEach(() => cleanup());

describe("WorkspaceMoreMenu", () => {
  it("renders nothing without content", () => {
    const { container } = render(<WorkspaceMoreMenu>{false}{null}</WorkspaceMoreMenu>);
    expect(container).toBeEmptyDOMElement();
  });

  it("has an accessible name, a tooltip on focus, and opens a menu", async () => {
    const onSelect = vi.fn();
    render(<WorkspaceMoreMenu><DropdownMenuItem onClick={onSelect}>Export</DropdownMenuItem></WorkspaceMoreMenu>);
    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(trigger).toHaveClass("size-11", "md:size-8");
    act(() => trigger.focus());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("More actions");
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export" }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("shows an activity dot only when something inside is non-default", () => {
    const { rerender } = render(<WorkspaceMoreMenu><DropdownMenuItem>Export</DropdownMenuItem></WorkspaceMoreMenu>);
    expect(document.querySelector('[data-slot="workspace-more-menu-dot"]')).toBeNull();
    rerender(<WorkspaceMoreMenu active><DropdownMenuItem>Export</DropdownMenuItem></WorkspaceMoreMenu>);
    expect(document.querySelector('[data-slot="workspace-more-menu-dot"]')).not.toBeNull();
  });
});

describe("WorkspaceIconButton", () => {
  it("explains why it is disabled on wrapper focus", async () => {
    render(<WorkspaceIconButton label="Reload" disabled disabledReason="Wait for changes to save" disabledLabel="Saving; reload unavailable">x</WorkspaceIconButton>);
    expect(screen.getByRole("button", { name: "Reload" })).toBeDisabled();
    act(() => screen.getByLabelText("Saving; reload unavailable").focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Wait for changes to save");
  });
});

describe("WorkspaceCreateButton", () => {
  it("keeps its accessible name when the visible label collapses", () => {
    const onClick = vi.fn();
    render(<WorkspaceCreateButton label="New task" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "New task" });
    expect(button.querySelector("span")).toHaveClass("hidden", "sm:inline");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("WorkspaceViewSwitcher", () => {
  const options = [
    { value: "board", label: "Board", icon: <Columns3 /> },
    { value: "list", label: "List", icon: <List /> },
  ];

  it("exposes icon-only options as named tabs and reports the selected one", () => {
    const onValueChange = vi.fn();
    render(<WorkspaceViewSwitcher value="board" onValueChange={onValueChange} options={options} />);
    expect(screen.getByRole("tablist", { name: "View" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
    const list = screen.getByRole("tab", { name: "List" });
    expect(list).toHaveAttribute("aria-selected", "false");
    expect(list).toHaveTextContent("");
    fireEvent.click(list);
    expect(onValueChange).toHaveBeenCalledWith("list");
  });
});

describe("WorkspaceHeader", () => {
  it("renders one h1 with actions and controls in their slots", () => {
    const { container } = render(<WorkspaceHeader title="Tasks" actions={<button>A</button>} controls={<button>C</button>} />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(container.querySelector('[data-slot="workspace-header-actions"]')).toContainElement(screen.getByText("A"));
    expect(container.querySelector('[data-slot="workspace-header-controls"]')).toContainElement(screen.getByText("C"));
  });

  it("omits empty slots", () => {
    const { container } = render(<WorkspaceHeader title="Tasks" />);
    expect(container.querySelector('[data-slot="workspace-header-actions"]')).toBeNull();
    expect(container.querySelector('[data-slot="workspace-header-controls"]')).toBeNull();
  });
});
