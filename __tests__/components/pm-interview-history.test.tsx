// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, expect, it } from "vitest"
import { PmInterviewHistory } from "@/components/research/pm-interview-history"
afterEach(cleanup)
it("labels linked history neutrally without exposing the private conversation link", () => {
  render(<PmInterviewHistory orgSlug="org" workspaceSlug="workspace" interviews={[{ id: "interview", disposition: "PENDING", generationState: "FAILED", agentConversationId: "private-conversation", createdAt: "2026-09-12" }]} />)
  const link = screen.getByRole("link", { name: /agent conversation/ })
  expect(link).toHaveAttribute("href", "/org/workspace/capture/pm/interview")
  expect(link).not.toHaveTextContent("failed")
  expect(link.outerHTML).not.toContain("private-conversation")
})
it("retains historical resolution labels for unlinked interviews", () => {
  render(<PmInterviewHistory orgSlug="org" workspaceSlug="workspace" interviews={[{ id: "interview", disposition: "APPLIED", generationState: "READY", createdAt: "2026-09-12" }]} />)
  expect(screen.getByRole("link", { name: /applied/ })).toBeVisible()
})
