// Test helpers for the composer's Agent / Model chips (role=button "Agent: <value>" opening a listbox).
import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { expect } from "vitest"

export type ChipKind = "Agent" | "Model"

export const chipButton = (kind: ChipKind) => screen.getByRole("button", { name: new RegExp(`^${kind}:`) })
export const queryChipButton = (kind: ChipKind) => screen.queryByRole("button", { name: new RegExp(`^${kind}:`) })
export const findChipButton = (kind: ChipKind) => screen.findByRole("button", { name: new RegExp(`^${kind}:`) })

/** The chip's current value as a user hears it, e.g. "Default (Triage)" or "Research Analyst (shared)". */
export const chipValue = (kind: ChipKind) => chipButton(kind).getAttribute("aria-label")!.replace(`${kind}: `, "")

/** Opens the chip's list and lists the option names (then closes it again). */
export async function optionNames(kind: ChipKind): Promise<string[]> {
  await act(async () => { fireEvent.click(chipButton(kind)) })
  try {
    return (await screen.findAllByRole("option")).map((o) => o.getAttribute("aria-label")!)
  } finally {
    // Never leave a list open for the next assertion (or test): close it and wait until it is gone.
    if (screen.queryByRole("listbox")) {
      await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }) })
      await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    }
  }
}

/** Opens the chip and picks the option with exactly this accessible name. */
export async function choose(kind: ChipKind, optionName: string) {
  await act(async () => { fireEvent.click(chipButton(kind)) })
  const option = await screen.findByRole("option", { name: optionName })
  await act(async () => { fireEvent.click(option) })
}
