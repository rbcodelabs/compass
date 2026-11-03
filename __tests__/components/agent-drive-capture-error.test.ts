// @vitest-environment jsdom
import { expect, it } from "vitest"
import { describeCaptureError } from "@/components/agent/agent-drive"

it("passes an Error message through", () => {
  expect(describeCaptureError(new Error("boom"))).toBe("boom")
})

it("names the resource when html-to-image rejects with an Event", () => {
  const img = document.createElement("img")
  img.src = "https://example.com/missing.png"
  document.body.appendChild(img)
  let caught: Event | null = null
  img.addEventListener("error", (event) => { caught = event })
  img.dispatchEvent(new Event("error"))
  const message = describeCaptureError(caught)
  expect(message).toContain("failed to load")
  expect(message).toContain("error")
  expect(message).toContain("missing.png")
})

it("describes strings and unknown values instead of a generic failure", () => {
  expect(describeCaptureError("nope")).toBe("nope")
  expect(describeCaptureError(undefined)).toContain("non-Error")
})
