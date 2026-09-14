// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const revokeApiKey = vi.fn(async () => undefined);
const createApiKey = vi.fn();

vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/actions", () => ({
  revokeApiKey: (...args: unknown[]) => revokeApiKey(...(args as [])),
  createApiKey: (...args: unknown[]) => createApiKey(...(args as [])),
}));

import { ManageApiKeysPanel, type ApiKeyRow } from "@/components/settings/manage-api-keys-panel";

function key(overrides: Partial<ApiKeyRow> & Pick<ApiKeyRow, "id" | "name">): ApiKeyRow {
  return {
    keyPrefix: "abcd1234",
    createdAt: new Date("2026-01-02T00:00:00Z"),
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function renderPanel(initialKeys: ApiKeyRow[]) {
  return render(
    <ManageApiKeysPanel orgSlug="rbcodelabs" workspaceSlug="compass" initialKeys={initialKeys} />,
  );
}

describe("ManageApiKeysPanel", () => {
  beforeEach(() => {
    // The grid reads `matchMedia` through `useIsMobile`; jsdom ships none.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  });

  afterEach(() => {
    cleanup();
    revokeApiKey.mockClear();
  });

  it("lists active keys with their prefix and last-used state", () => {
    renderPanel([
      key({ id: "k1", name: "Claude Desktop" }),
      key({ id: "k2", name: "CI", lastUsedAt: new Date("2026-03-04T00:00:00Z") }),
    ]);

    const rows = screen.getAllByTestId("grid-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Claude Desktop")).toBeInTheDocument();
    expect(within(rows[0]).getByText("cmp_abcd1234…")).toBeInTheDocument();
    // An unused key says so rather than showing an empty cell.
    expect(within(rows[0]).getByText("Never")).toBeInTheDocument();
    expect(within(rows[1]).queryByText("Never")).not.toBeInTheDocument();
  });

  it("names the table for assistive technology without a visible Actions header", () => {
    renderPanel([key({ id: "k1", name: "Claude Desktop" })]);

    expect(screen.getByRole("table", { name: "Active API keys" })).toBeInTheDocument();
    // The trailing action column keeps an empty visible header, as it did when
    // it was an `sr-only` span.
    const heads = screen.getAllByRole("columnheader");
    expect(heads).toHaveLength(5);
    expect(heads[4]).toHaveTextContent("");
  });

  it("revokes a key and moves it into the collapsed archive", async () => {
    renderPanel([key({ id: "k1", name: "Claude Desktop" }), key({ id: "k2", name: "CI" })]);

    fireEvent.click(within(screen.getAllByTestId("grid-row")[0]).getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(revokeApiKey).toHaveBeenCalledWith("rbcodelabs", "compass", "k1");
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("grid-row")).toHaveLength(1);
    });

    // The archive is present but collapsed — the revoked row is not on screen.
    expect(screen.getByRole("button", { name: /1 revoked key/ })).toBeInTheDocument();
    expect(screen.queryByText("cmp_abcd1234… Revoked")).not.toBeInTheDocument();
  });

  it("surfaces a failed revoke instead of silently dropping the row", async () => {
    revokeApiKey.mockRejectedValueOnce(new Error("Key already revoked"));
    renderPanel([key({ id: "k1", name: "Claude Desktop" })]);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(screen.getByText("Key already revoked")).toBeInTheDocument();
    });
    expect(screen.getAllByTestId("grid-row")).toHaveLength(1);
  });

  it("renders no grid at all when there are no active keys", () => {
    renderPanel([]);

    expect(screen.queryByTestId("data-grid")).not.toBeInTheDocument();
    expect(screen.getByText("No API keys yet. Generate one above.")).toBeInTheDocument();
  });

  it("bounds its own height instead of growing without limit", () => {
    renderPanel([key({ id: "k1", name: "Claude Desktop" })]);

    const grid = screen.getByTestId("data-grid");
    expect(grid).toHaveAttribute("data-height", "natural");
    expect(grid).toHaveStyle({ "--data-grid-max-h": "20rem" });
    // Natural mode must not claim flex height: this panel sits on a normally
    // scrolling settings page, not in a clipping content area.
    expect(grid.className).not.toMatch(/(?:^|\s)flex-1(?:\s|$)/);
  });
});
