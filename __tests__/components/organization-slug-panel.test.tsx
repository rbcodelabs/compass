// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const updateOrganizationSlug = vi.fn();
vi.mock("@/app/[orgSlug]/settings/actions", () => ({
  updateOrganizationSlug: (...args: unknown[]) => updateOrganizationSlug(...args),
}));

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

import { OrganizationSlugPanel } from "@/components/settings/organization-slug-panel";

function type(value: string) {
  fireEvent.change(screen.getByLabelText("Organization URL slug"), { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("OrganizationSlugPanel", () => {
  it("starts unchanged: the change button is disabled and nothing is flagged", () => {
    render(<OrganizationSlugPanel orgSlug="acme" />);
    expect(screen.getByLabelText("Organization URL slug")).toHaveValue("acme");
    expect(screen.getByRole("button", { name: "Change URL slug" })).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lowercases input and shows a validation error for a reserved word, without enabling submit", () => {
    render(<OrganizationSlugPanel orgSlug="acme" />);
    type("API");
    expect(screen.getByLabelText("Organization URL slug")).toHaveValue("api");
    expect(screen.getByRole("alert")).toHaveTextContent(/reserved/i);
    expect(screen.getByRole("button", { name: "Change URL slug" })).toBeDisabled();
  });

  it("requires a confirmation step that warns about links; the action is not called before it", () => {
    render(<OrganizationSlugPanel orgSlug="acme" />);
    type("acme-labs");
    fireEvent.click(screen.getByRole("button", { name: "Change URL slug" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(/old links stop working immediately/i);
    expect(dialog).toHaveTextContent(/portal/i);
    expect(dialog).toHaveTextContent(/MCP and API clients/i);
    expect(updateOrganizationSlug).not.toHaveBeenCalled();
  });

  it("cancel closes the confirmation without calling the action", () => {
    render(<OrganizationSlugPanel orgSlug="acme" />);
    type("acme-labs");
    fireEvent.click(screen.getByRole("button", { name: "Change URL slug" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(updateOrganizationSlug).not.toHaveBeenCalled();
  });

  it("confirming calls the action and navigates to the new slug's settings", async () => {
    updateOrganizationSlug.mockResolvedValue({ ok: true, slug: "acme-labs", redirectTo: "/acme-labs/settings" });
    render(<OrganizationSlugPanel orgSlug="acme" />);
    type("acme-labs");
    fireEvent.click(screen.getByRole("button", { name: "Change URL slug" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, change URL slug" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/acme-labs/settings"));
    expect(updateOrganizationSlug).toHaveBeenCalledWith("acme", "acme-labs");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the server's failure, stays on the page, and closes the confirmation", async () => {
    updateOrganizationSlug.mockResolvedValue({ ok: false, error: "That URL slug is already taken. Choose another." });
    render(<OrganizationSlugPanel orgSlug="acme" />);
    type("taken");
    fireEvent.click(screen.getByRole("button", { name: "Change URL slug" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, change URL slug" }));
    expect(await screen.findByText("That URL slug is already taken. Choose another.")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
