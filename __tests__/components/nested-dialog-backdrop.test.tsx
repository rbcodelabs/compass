// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

/**
 * Entity detail panels (components/panels/panel-shell.tsx) are built on Sheet,
 * which is a Base UI Dialog. Any dialog opened from inside a panel is therefore
 * a *nested* dialog, and Base UI suppresses a nested dialog's Backdrop by
 * default (`enabled: forceRender || !nested` in DialogBackdrop) so a stacked-
 * dialog visual treatment can show the parent through. Compass has no such
 * treatment, so the suppressed backdrop meant the panel behind an open dialog
 * was neither dimmed nor pointer-blocked — a user could click straight through
 * a modal into the panel that opened it. Found by production verification of
 * PR #230.
 *
 * These tests pin the backdrop's presence and its rung on the stacking ladder
 * (app/globals.css) for the nested case specifically, because the non-nested
 * case was never broken and would not have caught this.
 */

function overlay(slot: "dialog-overlay" | "alert-dialog-overlay") {
  return document.querySelector(`[data-slot="${slot}"]`);
}

describe("dialog backdrop inside an entity detail panel", () => {
  afterEach(() => cleanup());

  it("renders a backdrop for a dialog opened from inside a panel", () => {
    render(
      <Sheet open>
        <SheetContent className="z-[60]">
          <SheetTitle>Task</SheetTitle>
          <Dialog open>
            <DialogContent>
              <DialogTitle>Link existing task</DialogTitle>
            </DialogContent>
          </Dialog>
        </SheetContent>
      </Sheet>
    );

    // Guard the premise: if Base UI stops treating this as nested, the
    // regression this test protects against no longer applies and the test
    // would silently start passing for the wrong reason.
    expect(document.querySelector('[data-slot="dialog-content"]')).toHaveAttribute(
      "data-nested"
    );

    expect(overlay("dialog-overlay")).not.toBeNull();
  });

  it("puts the nested backdrop on the dialog layer, above the panel layer", () => {
    render(
      <Sheet open>
        <SheetContent className="z-[60]">
          <SheetTitle>Task</SheetTitle>
          <Dialog open>
            <DialogContent>
              <DialogTitle>Link existing task</DialogTitle>
            </DialogContent>
          </Dialog>
        </SheetContent>
      </Sheet>
    );

    const backdrop = overlay("dialog-overlay");
    // Dialog layer (70) clears the panel layer (60) it is opened from, and is
    // still below the dialog content it sits behind (also 70, wins on DOM
    // order). A backdrop at 50 would paint under the panel — the shipped bug.
    expect(backdrop).toHaveClass("z-[70]");
    expect(backdrop).toHaveClass("fixed", "inset-0");
  });

  it("renders a backdrop for a nested alert dialog too", () => {
    render(
      <Sheet open>
        <SheetContent className="z-[60]">
          <SheetTitle>Task</SheetTitle>
          <AlertDialog open>
            <AlertDialogContent>
              <AlertDialogTitle>Delete this task?</AlertDialogTitle>
            </AlertDialogContent>
          </AlertDialog>
        </SheetContent>
      </Sheet>
    );

    expect(
      document.querySelector('[data-slot="alert-dialog-content"]')
    ).toHaveAttribute("data-nested");
    expect(overlay("alert-dialog-overlay")).toHaveClass("z-[70]");
  });

  it("still renders exactly one backdrop per dialog (no doubled scrim)", () => {
    render(
      <Sheet open>
        <SheetContent className="z-[60]">
          <SheetTitle>Task</SheetTitle>
          <Dialog open>
            <DialogContent>
              <DialogTitle>Link existing task</DialogTitle>
            </DialogContent>
          </Dialog>
        </SheetContent>
      </Sheet>
    );

    // One scrim per surface, not two per dialog. The Sheet keeps its own
    // single backdrop on the surface layer (50) and the dialog adds exactly
    // one on the dialog layer (70). Measured in-browser, that composites to
    // 10% darkening over the panel (the Sheet's scrim is beneath the opaque
    // panel surface) and 19% over the page behind it — correct depth, not a
    // doubled scrim. A second dialog-overlay here would mean real doubling.
    expect(document.querySelectorAll('[data-slot="dialog-overlay"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-slot="sheet-overlay"]')).toHaveLength(1);
  });

  it("does not regress a non-nested dialog (⌘K palette shape)", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Search workspace</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    expect(
      document.querySelector('[data-slot="dialog-content"]')
    ).not.toHaveAttribute("data-nested");
    expect(overlay("dialog-overlay")).toHaveClass("z-[70]");
    expect(document.querySelectorAll('[data-slot="dialog-overlay"]')).toHaveLength(1);
  });
});
