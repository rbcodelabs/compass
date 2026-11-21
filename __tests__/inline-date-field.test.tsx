// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineDateField } from "@/components/tasks/inline-date-field";

const patch = vi.hoisted(() => vi.fn());
vi.mock("@/components/panels/panel-parts", () => ({ patchEntityField: patch }));

const edit = { type: "task" as const, id: "task", orgSlug: "org", workspaceSlug: "ws", onSaved: vi.fn() };
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("InlineDateField", () => {
  it.each([null, "2026-09-01T00:00:00.000Z"])("distinguishes start and due date controls when value is %s", (value) => {
    render(<><InlineDateField value={value} field="startDate" edit={edit} /><InlineDateField value={value} field="dueDate" edit={edit} /></>);
    expect(screen.getByRole("button", { name: /^Start date:/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Due date:/ })).toBeInTheDocument();
  });

  it("shows a validation failure and allows retry", async () => {
    patch.mockRejectedValueOnce(new Error("save failed")).mockResolvedValueOnce({ data: {} });
    render(<InlineDateField value={null} field="startDate" edit={edit} />);
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByLabelText("Edit startDate");
    fireEvent.change(input, { target: { value: "2026-09-11" } });
    fireEvent.blur(input);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not save.*may be invalid.*try again/i);
    expect(edit.onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(screen.getByLabelText("Edit startDate"), { target: { value: "2026-09-10" } });
    fireEvent.blur(screen.getByLabelText("Edit startDate"));
    await vi.waitFor(() => expect(edit.onSaved).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
