// @vitest-environment jsdom
import * as React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { CommentTaskCard } from "@/components/docs/comment-task-card"
import type { CommentTaskCardData } from "@/lib/comment-task-card"

const card = (over: Partial<CommentTaskCardData> = {}): CommentTaskCardData => ({
  taskId: "t1", displayId: "TASK-1", title: "Draft", status: "TODO", priority: "MEDIUM", dueDate: null,
  assignee: { type: "USER", id: "u1", displayName: "Quinn", available: true }, ...over,
})
afterEach(cleanup)

describe("CommentTaskCard", () => {
  it("lets an unbroken 255-character title and a very long assignee name wrap inside the card", () => {
    render(<CommentTaskCard taskHref="/t/1" card={card({ title: "L".repeat(255), assignee: { type: "USER", id: "u1", displayName: "W".repeat(70), available: true } })} />)
    const title = screen.getByText("L".repeat(255))
    expect(title.className).toMatch(/min-w-0/)
    expect(title.className).toMatch(/break-words/)
    expect(title.className).toMatch(/overflow-wrap:anywhere/)
    expect(screen.getByTestId("comment-task-card").className).toMatch(/min-w-0/)
    expect(screen.getByText("W".repeat(70)).className).toMatch(/break-words/)
  })

  it("shows an Unavailable cue when the assignee left the workspace or the agent lost its grant", () => {
    render(<CommentTaskCard taskHref="/t/1" card={card({ assignee: { type: "USER", id: "u1", displayName: "Unavailable person", available: false } })} />)
    expect(screen.getByTestId("assignee-unavailable")).toHaveTextContent("Unavailable")
  })

  it("shows no cue for an available assignee", () => {
    render(<CommentTaskCard taskHref="/t/1" card={card()} />)
    expect(screen.queryByTestId("assignee-unavailable")).toBeNull()
  })
})
