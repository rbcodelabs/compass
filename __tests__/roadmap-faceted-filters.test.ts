// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

afterEach(cleanup);

describe("Roadmap faceted filters", () => {
  it("provides a reusable grouped filter menu with active count and clear all", async () => {
    const { FacetedFilterMenu } = await import("@/components/patterns/faceted-filter-menu");
    const onClearAll = vi.fn();
    const onValueChange = vi.fn();

    render(
      createElement(FacetedFilterMenu, {
        onClearAll,
        groups: [
          {
            id: "squad",
            label: "Squad",
            value: "growth-id",
            options: [{ value: "growth-id", label: "Growth", color: "#ff0000" }],
            onValueChange,
          },
        ],
      }),
    );

    // Multiple groups each render their own label, and the option's color
    // renders as an actual swatch on the actually-rendered radio item, not
    // just a substring somewhere in the file.
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(await screen.findByText("Squad")).toBeInTheDocument();
    const radioItem = screen.getByRole("menuitemradio", { name: "Growth" });
    expect(radioItem).toBeInTheDocument();
    const swatch = radioItem.querySelector("span[style]");
    expect(swatch).toHaveStyle({ backgroundColor: "#ff0000" });

    // One active group (a non-null value) shows a live count badge and
    // exposes "Clear all", which really calls onClearAll when clicked.
    expect(screen.getByText("1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Clear all"));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("adapts squads to the menu in the Roadmap header and preserves the squad query parameter", async () => {
    const push = vi.fn();
    vi.doMock("next/navigation", () => ({
      useRouter: () => ({ push }),
      usePathname: () => "/rbcodelabs/compass/roadmap",
      useSearchParams: () => new URLSearchParams("view=timeline"),
    }));

    const { RoadmapHeader } = await import("@/components/roadmap/roadmap-header");
    const squads = [{ id: "squad-1", name: "Growth", color: "#00ff00" }];

    render(createElement(RoadmapHeader, { squads }));

    fireEvent.click(screen.getByRole("button", { name: "View options" }));
    expect(await screen.findByText("Squad")).toBeInTheDocument();

    // Selecting a squad preserves the pre-existing "view" query parameter
    // while adding "squad" — this is the real useUrlState -> router.push
    // call, not a grep of the adapter's source for the literal set({...}).
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Growth" }));
    expect(push).toHaveBeenCalledTimes(1);
    const [firstHref] = push.mock.calls[0];
    const firstUrl = new URL(firstHref, "http://example.test");
    expect(firstUrl.pathname).toBe("/rbcodelabs/compass/roadmap");
    expect(firstUrl.searchParams.get("view")).toBe("timeline");
    expect(firstUrl.searchParams.get("squad")).toBe("squad-1");

    vi.doUnmock("next/navigation");
  });

  // TODO(test-debt): still a source-text check, not a real render — page.tsx Server Components (auth/prisma/notFound) have no test-execution precedent in this repo yet. See Compass test-suite audit 2026-09-12 and the readFileSync anti-pattern finding. Do not treat this as verified behavior.
  describe("roadmap page wiring (source-text check only, not a real render)", () => {
    it("mounts RoadmapHeader with squads instead of the retired toolbar/SquadFilterBar", () => {
      const page = source("app/[orgSlug]/[workspaceSlug]/roadmap/page.tsx");

      // Mounted with `squads`; extra props (e.g. custom-field filter facets) are allowed.
      expect(page).toMatch(/<RoadmapHeader\b[^>]*\bsquads=\{squads\}/s);
      expect(page).not.toContain("toolbar={");
      expect(page).not.toContain("SquadFilterBar");
    });
  });
});
