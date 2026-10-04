// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { BuildFromDiscovery } from "./build-from-discovery";
import type { CatalogSolution } from "@/lib/roadmap/rail";

const sol = (id: string, over: Partial<CatalogSolution> = {}): CatalogSolution => ({
  id, title: `Solution ${id}`, status: "VALIDATED", score: null, opportunityId: "opp-1", opportunityTitle: "Opp one", squadId: null, ...over,
});
const catalog = {
  solutions: [
    sol("a", { score: 82 }),
    sol("b", { score: 40, opportunityId: "opp-2" }),
    sol("c", { status: "IN_DELIVERY", score: 75 }),
    sol("d", { status: "IDEA", score: 95 }),
    sol("e"),
  ],
};

afterEach(cleanup);

describe("BuildFromDiscovery", () => {
  it("explains what is ready and offers Build from discovery and Add an item manually", () => {
    render(<BuildFromDiscovery catalog={catalog} scheduledIds={new Set(["e"])} onBuild={vi.fn()} onAddManually={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /Your roadmap is empty/ })).toBeInTheDocument();
    // a and b are validated and unscheduled; e is scheduled; c is building; d is only an idea.
    expect(screen.getByText(/2 validated solutions across 2 opportunities are ready to plan/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Build from discovery" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Add an item manually" })).toBeInTheDocument();
  });

  it("calls the manual path", () => {
    const onAddManually = vi.fn();
    render(<BuildFromDiscovery catalog={catalog} scheduledIds={new Set()} onBuild={vi.fn()} onAddManually={onAddManually} />);
    fireEvent.click(screen.getByRole("button", { name: "Add an item manually" }));
    expect(onAddManually).toHaveBeenCalled();
  });

  it("opens the presets with their counts and creates exactly the chosen preset", async () => {
    const onBuild = vi.fn().mockResolvedValue([]);
    render(<BuildFromDiscovery catalog={catalog} scheduledIds={new Set(["e"])} onBuild={onBuild} onAddManually={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Build from discovery" }));
    const group = screen.getByRole("group", { name: "Start with" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /All validated solutions · 2/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Top scored \(70\+\) · 2/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Currently building · 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create 2 roadmap items" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /Currently building · 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create 1 roadmap item" }));
    await waitFor(() => expect(onBuild).toHaveBeenCalledWith("building"));
  });

  it("disables Create when a preset matches nothing and reports a failure", async () => {
    const onBuild = vi.fn().mockRejectedValue(new Error("boom"));
    render(<BuildFromDiscovery catalog={{ solutions: [sol("a")] }} scheduledIds={new Set()} onBuild={onBuild} onAddManually={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Build from discovery" }));
    fireEvent.click(screen.getByRole("button", { name: /Currently building · 0/ }));
    expect(screen.getByRole("button", { name: "Create 0 roadmap items" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /All validated solutions · 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create 1 roadmap item" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not create the roadmap items");
    expect(screen.getByRole("button", { name: "Create 1 roadmap item" })).toBeEnabled();
  });

  it("copes with nothing validated", () => {
    render(<BuildFromDiscovery catalog={{ solutions: [] }} scheduledIds={new Set()} onBuild={vi.fn()} onAddManually={vi.fn()} />);
    expect(screen.getByText(/Nothing validated is waiting yet/)).toBeInTheDocument();
  });
});
