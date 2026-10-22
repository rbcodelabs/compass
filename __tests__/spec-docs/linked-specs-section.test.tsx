// @vitest-environment jsdom
/** The Specs (solution) and Discovery Plans (opportunity) sections, and the label/banner on a spec doc's own page. */
import { createElement } from "react"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ push: vi.fn(), loadScopeSpecs: vi.fn(), createSpec: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({ loadScopeSpecs: mocks.loadScopeSpecs, createSpec: mocks.createSpec }))

import { LinkedSpecsSection } from "@/components/specs/linked-specs-section"
import { SpecDocHeader } from "@/components/docs/spec-doc-header"

const WS = "11111111-1111-4111-8111-111111111111"
const SCOPE = "22222222-2222-4222-8222-222222222222"
const spec = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `3333333${n}-3333-4333-8333-333333333333`, title: `Spec - Checkout ${n}`, label: null, updatedAt: `2026-03-0${n}T10:00:00.000Z`, href: `/acme/alpha/docs/3333333${n}-3333-4333-8333-333333333333`, ...extra,
})

const mount = (scopeType: "SOLUTION" | "OPPORTUNITY" = "SOLUTION") =>
  render(createElement(LinkedSpecsSection, { scopeType, scopeId: SCOPE, orgSlug: "acme", workspaceSlug: "alpha" }))

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe("LinkedSpecsSection", () => {
  it("empty: says so and offers New spec to a member", async () => {
    mocks.loadScopeSpecs.mockResolvedValue({ workspaceId: WS, canCreate: true, specs: [] })
    mount()
    expect(await screen.findByText("No specs for this solution yet.")).toBeInTheDocument()
    expect(screen.getByText("Specs")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "New spec" })).toBeInTheDocument()
    expect(mocks.loadScopeSpecs).toHaveBeenCalledWith("acme", "alpha", "SOLUTION", SCOPE)
  })

  it("an opportunity gets Discovery Plans and New plan", async () => {
    mocks.loadScopeSpecs.mockResolvedValue({ workspaceId: WS, canCreate: true, specs: [] })
    mount("OPPORTUNITY")
    expect(await screen.findByText("No discovery plans for this opportunity yet.")).toBeInTheDocument()
    expect(screen.getByText("Discovery Plans")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "New plan" })).toBeInTheDocument()
    expect(mocks.loadScopeSpecs).toHaveBeenCalledWith("acme", "alpha", "OPPORTUNITY", SCOPE)
  })

  it("several specs: every one is listed in the order given, with its label, and Open existing comes before New", async () => {
    mocks.loadScopeSpecs.mockResolvedValue({ workspaceId: WS, canCreate: true, specs: [spec(3, { label: "Pricing" }), spec(2), spec(1, { label: "v1" })] })
    mount()
    const links = await screen.findAllByRole("link")
    expect(links.map((a) => a.textContent)).toEqual(["Spec - Checkout 3", "Spec - Checkout 2", "Spec - Checkout 1"])
    expect(links[0]).toHaveAttribute("href", "/acme/alpha/docs/33333333-3333-4333-8333-333333333333")
    expect(screen.getByText("Pricing")).toBeInTheDocument()
    expect(screen.getByText("v1")).toBeInTheDocument()
    const button = screen.getByRole("button", { name: "New spec" })
    // The list precedes the button in the document: nothing assumes there is only one spec, and creating is never the first thing offered.
    expect(links[links.length - 1].compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText("(3)", { exact: false })).toBeInTheDocument()
  })

  it("a read-only member sees the specs but no New button, with or without specs", async () => {
    mocks.loadScopeSpecs.mockResolvedValue({ workspaceId: WS, canCreate: false, specs: [spec(1)] })
    mount()
    await screen.findByRole("link", { name: "Spec - Checkout 1" })
    expect(screen.queryByRole("button", { name: /new (spec|plan)/i })).toBeNull()
    cleanup()
    mocks.loadScopeSpecs.mockResolvedValue({ workspaceId: WS, canCreate: false, specs: [] })
    mount("OPPORTUNITY")
    await screen.findByText("No discovery plans for this opportunity yet.")
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("New spec creates exactly one new doc for this scope and opens it; the button is disabled while it works", async () => {
    mocks.loadScopeSpecs.mockResolvedValue({ workspaceId: WS, canCreate: true, specs: [spec(1)] })
    let finish!: (value: { docId: string }) => void
    mocks.createSpec.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    mount()
    const button = await screen.findByRole("button", { name: "New spec" })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole("button")).toBeDisabled())
    fireEvent.click(screen.getByRole("button"))
    finish({ docId: "new-doc" })
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/acme/alpha/docs/new-doc"))
    expect(mocks.createSpec).toHaveBeenCalledTimes(1)
    expect(mocks.createSpec.mock.calls[0].slice(0, 3)).toEqual([WS, "SOLUTION", SCOPE])
  })

  it("opening the section never creates anything", async () => {
    mocks.loadScopeSpecs.mockResolvedValue({ workspaceId: WS, canCreate: true, specs: [] })
    mount()
    await screen.findByText("No specs for this solution yet.")
    expect(mocks.createSpec).not.toHaveBeenCalled()
  })

  it("a failed create shows the server's message and stays on the page", async () => {
    mocks.loadScopeSpecs.mockResolvedValue({ workspaceId: WS, canCreate: true, specs: [] })
    mocks.createSpec.mockResolvedValue({ error: "Solution not found in this workspace." })
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "New spec" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Solution not found in this workspace.")
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it("a failed load offers a retry", async () => {
    mocks.loadScopeSpecs.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce({ workspaceId: WS, canCreate: true, specs: [spec(1)] })
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }))
    expect(await screen.findByRole("link", { name: "Spec - Checkout 1" })).toBeInTheDocument()
  })
})

describe("SpecDocHeader", () => {
  const solution = { scopeType: "SOLUTION" as const, scopeId: "s1", title: "Checkout redesign", href: "/acme/alpha/discovery/o1?detail=solution%3As1" }
  const opportunity = { scopeType: "OPPORTUNITY" as const, scopeId: "o1", title: "Cart abandonment", href: "/acme/alpha/discovery/o1" }

  it("a solution-scoped doc is a Spec", () => {
    render(createElement(SpecDocHeader, { scopes: [solution] }))
    expect(screen.getByText("Spec")).toBeInTheDocument()
    expect(screen.queryByText("Discovery Plan")).toBeNull()
    expect(screen.getByRole("link", { name: /Checkout redesign/ })).toHaveAttribute("href", solution.href)
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("an opportunity-scoped doc is a Discovery Plan", () => {
    render(createElement(SpecDocHeader, { scopes: [opportunity] }))
    expect(screen.getByText("Discovery Plan")).toBeInTheDocument()
    expect(screen.queryByText("Spec")).toBeNull()
  })

  it("a doc linked to both kinds shows both", () => {
    render(createElement(SpecDocHeader, { scopes: [solution, opportunity] }))
    expect(screen.getByText("Spec")).toBeInTheDocument()
    expect(screen.getByText("Discovery Plan")).toBeInTheDocument()
    expect(screen.getAllByRole("link")).toHaveLength(2)
  })

  it("a doc with no scope is 'Spec (unscoped)' with an explanatory banner and no edit action", () => {
    const { container } = render(createElement(SpecDocHeader, { scopes: [] }))
    expect(screen.getAllByText("Spec (unscoped)").length).toBeGreaterThan(0)
    const banner = screen.getByRole("status")
    expect(within(banner).getByText(/no longer exists/)).toBeInTheDocument()
    expect(container.querySelector("button")).toBeNull()
  })
})
