// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/app/[orgSlug]/[workspaceSlug]/reviews/actions", () => ({ requestNowCommitmentAction: vi.fn() }))

import { NowCommitmentCard } from "@/components/roadmap/now-commitment-card"

describe("NowCommitmentCard", () => {
  afterEach(cleanup)

  it("renders the canonical native-gated provenance as decision-backed", () => {
    render(<NowCommitmentCard
      itemId="item-1"
      workspaceId="workspace-1"
      orgSlug="org"
      workspaceSlug="workspace"
      horizon="NOW"
      review={null}
      provenance="NATIVE_GATED"
      decisionRecordId={null}
      application={null}
    />)

    expect(screen.getByText(/native decision provenance/i)).toBeTruthy()
    expect(screen.queryByText(/legacy ungated provenance/i)).toBeNull()
  })
})
