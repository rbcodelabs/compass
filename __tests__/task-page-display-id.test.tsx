import { beforeEach, describe, expect, it, vi } from "vitest"

const { findFirst, requireContext, taskDetail } = vi.hoisted(() => ({ findFirst: vi.fn(), requireContext: vi.fn(), taskDetail: vi.fn(() => null) }))
vi.mock("@/lib/db", () => ({ default: () => ({ task: { findFirst } }) }))
vi.mock("@/lib/workspace-context", () => ({ getWorkspaceContext: vi.fn(), requireWorkspaceContext: requireContext }))
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND") },
  permanentRedirect: (url: string) => { throw new Error(`REDIRECT:${url}`) },
}))
vi.mock("@/components/tasks/task-detail", () => ({ TaskDetail: taskDetail }))

import TaskDetailPage from "@/app/[orgSlug]/[workspaceSlug]/tasks/[taskId]/page"

const UUID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const page = (taskId: string, searchParams?: Record<string, string>) =>
  TaskDetailPage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product", taskId }), searchParams: Promise.resolve(searchParams) })

// Every `taskId` prop in the rendered element tree (the page passes it to TaskDetail).
function findTaskIds(node: unknown, found: string[] = []): string[] {
  if (!node || typeof node !== "object") return found
  const element = node as { props?: { taskId?: string; children?: unknown } }
  if (typeof element.props?.taskId === "string") found.push(element.props.taskId)
  const children = element.props?.children
  for (const child of Array.isArray(children) ? children : [children]) findTaskIds(child, found)
  return found
}

beforeEach(() => {
  vi.resetAllMocks()
  requireContext.mockResolvedValue({ workspace: { id: "ws-1" } })
})

describe("task page with display IDs", () => {
  it("serves a display-ID URL and hands the UUID, never the display ID, to the detail component", async () => {
    findFirst.mockResolvedValue({ id: UUID, seqPrefix: "TASK", seqNumber: 5, parentTaskId: null })
    const element = await page("TASK-5")
    expect(findTaskIds(element)).toEqual([UUID])
    expect(findFirst.mock.calls[0][0].where).toEqual({ workspaceId: "ws-1", seqPrefix: "TASK", seqNumber: 5 })
  })

  it("308s a numbered row's UUID URL to its display ID and keeps the query", async () => {
    findFirst.mockResolvedValue({ id: UUID, seqPrefix: "TASK", seqNumber: 5, parentTaskId: null })
    await expect(page(UUID, { tab: "links" })).rejects.toThrow("REDIRECT:/acme/product/tasks/TASK-5?tab=links")
  })

  it("keeps serving an un-numbered row on its UUID", async () => {
    findFirst.mockResolvedValue({ id: UUID, seqPrefix: null, seqNumber: null, parentTaskId: null })
    await expect(page(UUID)).resolves.toBeDefined()
  })

  it("404s an unknown display ID and a display ID of another type", async () => {
    findFirst.mockResolvedValue(null)
    await expect(page("TASK-99")).rejects.toThrow("NOT_FOUND")
    await expect(page("OPP-1")).rejects.toThrow("NOT_FOUND")
  })
})
