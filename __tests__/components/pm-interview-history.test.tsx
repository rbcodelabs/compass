// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, expect, it } from "vitest"
import { PmInterviewHistory } from "@/components/research/pm-interview-history"
import { FleshThisOutLink } from "@/components/research/flesh-this-out-link"
import { readFileSync } from "node:fs"
afterEach(cleanup)
it("labels the existing refinement action without changing its route", () => {
  render(<FleshThisOutLink orgSlug="org" workspaceSlug="workspace" targetType="OPPORTUNITY" targetId="target" />)
  expect(screen.getByRole("link", { name: /^Refine$/ })).toHaveAttribute("href", "/org/workspace/capture/pm/new?targetType=OPPORTUNITY&targetId=target")
})
it("uses Refinement page titles and the new opening only for newly created transcripts", () => {
  for (const page of ["new", "[interviewId]"]) {
    expect(readFileSync(`app/[orgSlug]/[workspaceSlug]/capture/pm/${page}/page.tsx`, "utf8")).toContain('title="Refinement"')
  }
  const service = readFileSync("lib/pm-interview-service.ts", "utf8")
  expect(service).toContain('content: `Let’s refine this. ${guide[0].text}`')
  expect(service).not.toContain("Let’s flesh this out")
})
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
