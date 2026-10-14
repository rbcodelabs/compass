// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { UndoToastHost } from "@/components/ui/undo-toast-host";
import { dismissUndoToast, getUndoToasts, pushUndoToast, resetUndoToasts } from "@/lib/ui/undo-toast";

beforeEach(() => { vi.useFakeTimers(); resetUndoToasts(); });
afterEach(() => { cleanup(); vi.useRealTimers(); resetUndoToasts(); });

describe("undo toast store", () => {
  it("keeps the latest few toasts and removes one on dismiss", () => {
    const ids = Array.from({ length: 6 }, (_, index) => pushUndoToast({ message: `m${index}` }));
    expect(getUndoToasts().map((toast) => toast.message)).toEqual(["m2", "m3", "m4", "m5"]);
    dismissUndoToast(ids[5]);
    expect(getUndoToasts().map((toast) => toast.message)).toEqual(["m2", "m3", "m4"]);
    dismissUndoToast("missing");
    expect(getUndoToasts()).toHaveLength(3);
  });
});

describe("UndoToastHost", () => {
  it("announces a toast politely and runs Undo once, dismissing it", async () => {
    const onAction = vi.fn();
    render(<UndoToastHost />);
    act(() => { pushUndoToast({ message: "Created roadmap item", actionLabel: "Undo", onAction }); });
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status")).toHaveTextContent("Created roadmap item");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("undo-toast")).not.toBeInTheDocument();
  });

  it("dismisses itself after the duration and can be dismissed by hand", () => {
    render(<UndoToastHost />);
    act(() => { pushUndoToast({ message: "Soon gone", durationMs: 1000 }); });
    expect(screen.getByText("Soon gone")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1001); });
    expect(screen.queryByText("Soon gone")).not.toBeInTheDocument();
    act(() => { pushUndoToast({ message: "By hand" }); });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("By hand")).not.toBeInTheDocument();
  });

  it("marks an auto-added toast with its own tone", () => {
    render(<UndoToastHost />);
    act(() => { pushUndoToast({ message: "Auto-added", tone: "auto" }); });
    expect(screen.getByTestId("undo-toast")).toHaveAttribute("data-tone", "auto");
  });
});
