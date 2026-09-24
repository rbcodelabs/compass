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
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Updated" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ field: "description", value: "Updated" });
    expect(onSaved).toHaveBeenCalled();
  });

  it("does not save on blur, cancels without a request, and restores the persisted value", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<EditableText value="Old" field="description" multiline edit={{ type: "task", id: "1", orgSlug: "o", workspaceSlug: "w", onSaved: vi.fn() }} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Changed" } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    expect(screen.getByRole("textbox")).toHaveValue("Old");
  });

  it("preserves a failed draft, exposes an accessible error and retries", async () => {
    const onSaved = vi.fn();
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ ok: true, json: async () => ({ data: { description: "New" } }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<EditableText value="Old" field="description" multiline edit={{ type: "task", id: "1", orgSlug: "o", workspaceSlug: "w", onSaved }} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("textbox")).toHaveValue("New");
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ description: "New" }));
  });

  it("clears descriptions to null", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { description: null } }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<EditableText value="Old" field="description" multiline edit={{ type: "task", id: "1", orgSlug: "o", workspaceSlug: "w", onSaved: vi.fn() }} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).value).toBeNull();
  });

  it("does not carry a draft into another entity", () => {
    const edit = { type: "task" as const, id: "1", orgSlug: "o", workspaceSlug: "w", onSaved: vi.fn() };
    const { rerender } = render(<EditableText value="First" field="description" multiline edit={edit} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsaved" } });
    rerender(<EditableText value="Second" field="description" multiline edit={{ ...edit, id: "2" }} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Second")).toBeVisible();
  });
});
