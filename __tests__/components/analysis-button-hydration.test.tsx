// @vitest-environment jsdom
import { act } from "react"
import { renderToString } from "react-dom/server"
import { hydrateRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
const refresh = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))
import { AnalysisButton } from "@/components/research/analysis-button"

let root: Root | undefined
afterEach(async () => { if (root) await act(() => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it("does not advertise a usable analysis action before hydration attaches its handler", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }))
  vi.stubGlobal("fetch", fetch)
  const element = <AnalysisButton studyId="study" sessionId="session" kind="summary">Generate summary</AnalysisButton>
  const container = document.createElement("div")
  container.innerHTML = renderToString(element)
  document.body.append(container)
  const button = container.querySelector("button")!
  const serverDisabled = button.disabled
  expect(button.getAttribute("aria-busy")).toBe("true")
  button.click()
  expect(fetch).not.toHaveBeenCalled()
  await act(async () => { root = hydrateRoot(container, element) })
  // The pre-hydration click was not replayed after the handler became available.
  expect(fetch).not.toHaveBeenCalled()
  expect(button.disabled).toBe(false)
  expect(button.getAttribute("aria-busy")).toBe("false")
  await act(async () => { button.click() })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(serverDisabled).toBe(true)
})

it("keeps pending protection and an actionable error after hydration", async () => {
  let resolve!: (response: Response) => void
  const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done }))
  vi.stubGlobal("fetch", fetch)
  const element = <AnalysisButton studyId="study" sessionId="session" kind="summary">Generate summary</AnalysisButton>
  const container = document.createElement("div")
  container.innerHTML = renderToString(element)
  document.body.append(container)
  await act(async () => { root = hydrateRoot(container, element) })
  const button = container.querySelector("button")!
  await act(async () => { button.click() })
  expect(button.disabled).toBe(true)
  expect(button.textContent).toBe("Analyzing saved research…")
  expect(button.getAttribute("aria-busy")).toBe("true")
  button.click()
  expect(fetch).toHaveBeenCalledTimes(1)
  await act(async () => { resolve(Response.json({ error: "Please retry" }, { status: 503 })) })
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Please retry")
  expect(button.disabled).toBe(false)
  expect(button.textContent).toBe("Generate summary")
  expect(refresh).not.toHaveBeenCalled()
})
