// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { EditableText } from "@/components/panels/panel-parts";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("EditableText multiline Markdown", () => {
  it("keeps Markdown links separate from the edit control", () => {
    render(<EditableText value="Read [docs](https://example.com)" field="description" multiline edit={{ type: "opportunity", id: "1", orgSlug: "o", workspaceSlug: "w", onSaved: vi.fn() }} />);
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", "https://example.com");
    expect(screen.getByRole("button", { name: "Edit description" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "docs" }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("edits and saves from the explicit control", async () => {
    const onSaved = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { description: "Updated" } }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<EditableText value="Old" field="description" multiline edit={{ type: "opportunity", id: "1", orgSlug: "o", workspaceSlug: "w", onSaved }} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Updated" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ field: "description", value: "Updated" });
    expect(onSaved).toHaveBeenCalled();
  });
});
