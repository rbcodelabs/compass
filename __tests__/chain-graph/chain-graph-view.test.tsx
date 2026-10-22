// @vitest-environment jsdom
/**
 * Component tests for the chain graph view. React Flow is replaced at its module boundary (jsdom has no layout, so the
 * real one cannot measure nodes): the stub renders each node through the view's own nodeTypes, so the node components,
 * context wiring, layout, trace and cluster logic are the real ones.
 */
import { CHAIN_NODE_TYPES } from "@/lib/chain-graph/types"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { createElement, useState, type ReactNode } from "react"
import { act } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

const flowStore = vi.hoisted(() => ({
  transform: [0, 0, 1] as [number, number, number],
  listeners: new Set<(s: { transform: number[] }) => void>(),
  props: null as null | { onNodesChange: (changes: unknown[]) => void; onNodeDragStop: (e: unknown, node: unknown) => void },
}))

vi.mock("@xyflow/react/dist/style.css", () => ({}))
vi.mock("@xyflow/react", () => ({
  Position: { Left: "left", Right: "right" },
  Handle: () => null,
  Background: () => null,
  Controls: () => null,
  ViewportPortal: ({ children }: { children: ReactNode }) => createElement("div", { "data-testid": "viewport-portal" }, children),
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  useReactFlow: () => ({ fitView: vi.fn(), getNode: () => undefined, getZoom: () => 1, zoomIn: vi.fn(), zoomOut: vi.fn(), setViewport: vi.fn() }),
  useStoreApi: () => ({
    getState: () => ({ transform: flowStore.transform }),
    subscribe: (fn: (s: { transform: number[] }) => void) => {
      flowStore.listeners.add(fn)
      return () => flowStore.listeners.delete(fn)
    },
  }),
  // Applies position changes like the real hook, so a simulated drag moves the node in the view's own state.
  useNodesState: (initial: unknown[]) => {
    const [nodes, setNodes] = useState(initial)
    const onNodesChange = (changes: Array<{ type: string; id: string; position?: { x: number; y: number } }>) =>
      setNodes((cur) => (cur as Array<{ id: string }>).map((n) => ({ ...n, ...(changes.find((c) => c.type === "position" && c.id === n.id && c.position) ? { position: changes.find((c) => c.id === n.id)!.position } : {}) })))
    return [nodes, setNodes, onNodesChange]
  },
  ReactFlow: ({ nodes, edges, nodeTypes, children, onNodesChange, onNodeDragStop }: { onNodesChange: (c: unknown[]) => void; onNodeDragStop: (e: unknown, n: unknown) => void; nodes: Array<{ id: string; type: string; data: unknown; position: { x: number; y: number } }>; edges: Array<{ id: string; className?: string }>; nodeTypes: Record<string, React.ComponentType<{ data: unknown }>>; children?: ReactNode }) => {
    flowStore.props = { onNodesChange, onNodeDragStop }
    return createElement(
      "div",
      { "data-testid": "rf" },
      nodes.map((n) => createElement("div", { key: n.id, "data-id": n.id, "data-node-type": n.type, "data-x": n.position.x, "data-y": n.position.y }, createElement(nodeTypes[n.type], { data: n.data }))),
      edges.map((e) => createElement("i", { key: e.id, "data-edge": e.id, className: e.className })),
      children,
    )
  },
}))

import { ChainGraphView } from "@/components/chain-graph/chain-graph-view"
import { buildChainGraph } from "@/lib/chain-graph/build"
import { clusterKey } from "@/lib/chain-graph/cluster"
import { syntheticChainGraph } from "@/lib/chain-graph/synthetic"
import { overviewFixture } from "./fixtures"

afterEach(cleanup)
const graph = buildChainGraph(overviewFixture())
const nodeIds = () => [...document.querySelectorAll("[data-node-type]")].map((n) => n.getAttribute("data-id"))

describe("ChainGraphView", () => {
  it("renders every visible object, hides archived by default and shows them on request", () => {
    render(<ChainGraphView graph={graph} initialCollapse="none" />)
    expect(nodeIds()).toContain("OPPORTUNITY:p1")
    expect(nodeIds()).not.toContain("OPPORTUNITY:p2")
    fireEvent.click(screen.getByRole("switch", { name: "Show archived" }))
    expect(nodeIds()).toContain("OPPORTUNITY:p2")
  })

  it("selects an archived focus target with archived objects shown", () => {
    render(<ChainGraphView graph={graph} initialCollapse="none" initialFocus="OPPORTUNITY:p2" />)
    expect(nodeIds()).toContain("OPPORTUNITY:p2")
  })

  it("trace: selecting an object lists upstream and downstream in the outline and announces the counts", () => {
    render(<ChainGraphView graph={graph} initialCollapse="none" />)
    fireEvent.click(within(document.querySelector('[data-id="SOLUTION:s1"]') as HTMLElement).getByRole("button"))
    const upstream = screen.getByRole("region", { name: "Upstream" })
    expect(within(upstream).getByText(/Onboarding confusion/)).toBeTruthy()
    const downstream = screen.getByRole("region", { name: "Downstream" })
    expect(within(downstream).getByText(/Fake door/)).toBeTruthy()
    expect(screen.getByRole("status", { name: "" }).textContent).toMatch(/Tracing Checklist: \d+ upstream, \d+ downstream/)
  })

  it("trace: Escape clears the selection", () => {
    render(<ChainGraphView graph={graph} initialCollapse="none" initialFocus="SOLUTION:s1" />)
    expect(screen.queryByRole("region", { name: "Upstream" })).toBeTruthy()
    fireEvent.keyDown(document.querySelector(".chain-graph") as HTMLElement, { key: "Escape" })
    expect(screen.queryByRole("region", { name: "Upstream" })).toBeNull()
  })

  it("marks edges outside the trace as dimmed and removes them with hide unrelated", () => {
    render(<ChainGraphView graph={graph} initialCollapse="none" initialFocus="ASSUMPTION:a1" />)
    expect([...document.querySelectorAll("[data-edge]")].some((e) => e.className.includes("chain-edge--dim"))).toBe(true)
    const before = document.querySelectorAll("[data-edge]").length
    fireEvent.click(screen.getByRole("switch", { name: "Hide unrelated" }))
    expect(document.querySelectorAll("[data-edge]").length).toBeLessThan(before)
  })

  it("collapses a group from the keyboard (Enter on the cluster) and expands it again", () => {
    render(<ChainGraphView graph={graph} initialCollapse="all" />)
    const clusters = [...document.querySelectorAll('[data-node-type="cluster"]')]
    expect(clusters.length).toBeGreaterThan(0)
    const cluster = clusters[0]
    const key = cluster.getAttribute("data-id")!
    expect(key).toBe(clusterKey("objective", "o1"))
    fireEvent.keyDown(within(cluster as HTMLElement).getByRole("button"), { key: "Enter" })
    expect(document.querySelector(`[data-id="${key}"]`)).toBeNull()
    expect(nodeIds().some((id) => id?.startsWith("OPPORTUNITY:"))).toBe(true)
  })

  it("expands a cluster on double click", () => {
    render(<ChainGraphView graph={graph} initialCollapse="all" />)
    fireEvent.doubleClick(within(document.querySelector('[data-node-type="cluster"]') as HTMLElement).getByRole("button"))
    expect(document.querySelectorAll('[data-node-type="cluster"]').length).toBeLessThan(2)
  })

  it("clusters only above the element limit, with a visible notice", () => {
    const big = syntheticChainGraph(1000)
    render(<ChainGraphView graph={big} initialCollapse="none" />)
    expect(document.querySelectorAll('[data-node-type="chain"]').length).toBe(0)
    expect(document.querySelectorAll('[data-node-type="cluster"]').length).toBeGreaterThan(0)
    expect(screen.getByTestId("chain-graph-limit-notice").textContent).toMatch(/above the 1,000 limit/)
  })

  it("refuses to expand a group that would pass the limit, and keeps the view", () => {
    const big = syntheticChainGraph(1000)
    render(<ChainGraphView graph={big} initialCollapse="all" elementLimit={150} />)
    const before = document.querySelectorAll('[data-node-type="cluster"]').length
    // Every synthetic group is 40 nodes + 40 edges; the first expansion fits, the budget runs out after a couple
    for (let i = 0; i < 6; i++) {
      const c = document.querySelector('[data-node-type="cluster"]')
      if (!c) break
      fireEvent.doubleClick(within(c as HTMLElement).getByRole("button"))
    }
    expect(screen.getByTestId("chain-graph-limit-notice").textContent).toMatch(/Not expanded/)
    expect(document.querySelectorAll('[data-node-type="cluster"]').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('[data-node-type="cluster"]').length).toBeLessThan(before)
  })

  it("semantic zoom is driven by data-band on the canvas root and follows the store", () => {
    render(<ChainGraphView graph={graph} initialCollapse="none" />)
    const root = screen.getByTestId("chain-graph-canvas")
    expect(root.dataset.band).toBe("label") // zoom 1
    flowStore.transform = [0, 0, 0.2]
    flowStore.listeners.forEach((l) => l({ transform: flowStore.transform }))
    expect(root.dataset.band).toBe("dot")
    flowStore.transform = [0, 0, 2]
    flowStore.listeners.forEach((l) => l({ transform: flowStore.transform }))
    expect(root.dataset.band).toBe("full")
    flowStore.transform = [0, 0, 1]
  })

  it("labels types with the thinking model's names (default CLASSIC copy)", () => {
    render(<ChainGraphView graph={graph} initialCollapse="none" />)
    expect(screen.getByRole("group", { name: "Object types" }).textContent).toMatch(/Opportunity/)
  })

  it("renders each type's glyph inside its filter button; hiding a type dims the glyph and keeps toggling", () => {
    render(<ChainGraphView graph={graph} initialCollapse="none" />)
    const group = screen.getByRole("group", { name: "Object types" })
    const buttons = within(group).getAllByRole("button")
    expect(buttons).toHaveLength(CHAIN_NODE_TYPES.length)
    CHAIN_NODE_TYPES.forEach((type, i) => {
      const glyph = within(buttons[i]).getByTestId(`type-glyph-${type}`)
      expect(glyph.getAttribute("aria-hidden")).toBe("true")
      expect(glyph.dataset.dimmed).toBe("false")
      expect(glyph.style.background).toContain("--graph-series-")
    })
    fireEvent.click(buttons[1])
    expect(buttons[1].getAttribute("aria-pressed")).toBe("false")
    expect(within(buttons[1]).getByTestId(`type-glyph-${CHAIN_NODE_TYPES[1]}`).dataset.dimmed).toBe("true")
    expect(within(buttons[0]).getByTestId(`type-glyph-${CHAIN_NODE_TYPES[0]}`).dataset.dimmed).toBe("false")
    fireEvent.click(buttons[1])
    expect(buttons[1].getAttribute("aria-pressed")).toBe("true")
    expect(within(buttons[1]).getByTestId(`type-glyph-${CHAIN_NODE_TYPES[1]}`).dataset.dimmed).toBe("false")
  })

  it("outline search lists matches when nothing is selected, and Open calls onOpenDetails", () => {
    const open = vi.fn()
    render(<ChainGraphView graph={graph} initialCollapse="none" onOpenDetails={open} />)
    fireEvent.change(screen.getByLabelText("Search objects"), { target: { value: "checklist" } })
    const matches = screen.getByRole("region", { name: "Search results" })
    fireEvent.click(within(matches).getByRole("button", { name: /Open details for Checklist/ }))
    expect(open).toHaveBeenCalledWith("SOLUTION", "s1")
  })

  describe("dragging", () => {
    const pos = (id: string) => {
      const el = document.querySelector(`[data-id="${id}"]`)!
      return { x: Number(el.getAttribute("data-x")), y: Number(el.getAttribute("data-y")) }
    }
    const haloTransforms = () => [...document.querySelectorAll(".chain-halo")].map((h) => (h as HTMLElement).style.transform)
    const drag = (id: string, by: { x: number; y: number }) => {
      const from = pos(id)
      const to = { x: from.x + by.x, y: from.y + by.y }
      act(() => flowStore.props!.onNodesChange([{ type: "position", id, position: to }]))
      act(() => flowStore.props!.onNodeDragStop({}, { id, position: to }))
      return to
    }

    it("a dragged node moves, and its group halo follows it from live positions", () => {
      render(<ChainGraphView graph={syntheticChainGraph(120)} initialCollapse="none" initialGroupBy="type" />)
      const id = "SOLUTION:o0-p0-s0"
      const haloBefore = haloTransforms()
      const to = drag(id, { x: 400, y: 250 })
      expect(pos(id)).toEqual(to)
      expect(haloTransforms()).not.toEqual(haloBefore)
    })

    it("a dropped node stays pinned and other nodes do not move when the view relayouts", () => {
      render(<ChainGraphView graph={syntheticChainGraph(120)} initialCollapse="none" initialGroupBy="type" />)
      const id = "SOLUTION:o0-p0-s0"
      const others = nodeIds().filter((n) => n !== id && n !== "ROADMAP_ITEM:o0-p0-s0-r")
      const snapshot = new Map(others.map((n) => [n!, pos(n!)]))
      const to = drag(id, { x: 400, y: 250 })
      // Hiding a type relayouts the view: the dragged node must stay where it was dropped and the other groups must not be reshuffled.
      fireEvent.click(screen.getByRole("button", { name: "Roadmap" }))
      expect(pos(id)).toEqual(to)
      for (const [n, p] of snapshot) if (document.querySelector(`[data-id="${n}"]`)) expect(pos(n)).toEqual(p)
    })
  })

  it("reports truncation", () => {
    render(<ChainGraphView graph={{ ...graph, truncated: { byType: {}, shown: 3, total: 9 } }} initialCollapse="none" />)
    expect(screen.getByText(/Showing 3 of 9 objects/)).toBeTruthy()
  })
})
