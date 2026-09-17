// @vitest-environment jsdom
/**
 * ADR-0012 step 6a — the human-visible half of ADR-0002 invariant 6.
 *
 * `promote_research_finding_to_evidence` has recorded exact source turns since
 * migration 052, but a researcher looking at an Evidence row could not see any
 * of it. These tests pin both halves of the requirement:
 *
 *  - a promoted row visibly cites its sources, each deep-linking to the saved
 *    turn through the SAME `?turnId=` route the synthesis results view uses
 *    (lib/research-turn-link.ts), and
 *  - a row with no provenance — every pre-052 row and everything `add_evidence`
 *    creates — renders byte-identically to how it did before this feature, which
 *    is asserted by rendering the identical item with and without a promoted
 *    sibling and comparing the markup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  deleteEvidence: vi.fn(),
}));

import { EvidenceList, type EvidenceListItem } from "@/components/discovery/evidence-list";

const STUDY = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const TURN_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const TURN_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

const plain: EvidenceListItem = {
  id: "plain-1",
  sourceType: "support_ticket",
  excerpt: "Three tickets this week about the same thing.",
  sourceUrl: "https://example.com/ticket/1",
  confidence: "medium",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

const promoted: EvidenceListItem = {
  id: "promoted-1",
  sourceType: "interview",
  excerpt: "Mobile export is unusable — participants abandoned the flow on phones.",
  sourceUrl: null,
  confidence: "high",
  createdAt: new Date("2026-03-03T03:03:03Z"),
  research: {
    researchSynthesisId: "22222222-2222-4222-8222-222222222222",
    sources: [
      { researchTurnId: TURN_1, studyId: STUDY, sessionId: SESSION, sequence: 3, role: "PARTICIPANT", resolved: true },
      { researchTurnId: TURN_2, studyId: STUDY, sessionId: SESSION, sequence: 7, role: "PARTICIPANT", resolved: true },
    ],
  },
};

const show = (evidence: EvidenceListItem[]) =>
  render(<EvidenceList evidence={evidence} revalidatePathStr="/acme/product/discovery" orgSlug="acme" workspaceSlug="product" />);

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("EvidenceList — research provenance", () => {
  it("cites each source turn with the study deep link the synthesis view uses", () => {
    show([promoted]);
    const block = screen.getByTestId("evidence-provenance");

    const links = within(block).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", `/acme/product/capture/studies/${STUDY}?turnId=${TURN_1}`);
    expect(links[1]).toHaveAttribute("href", `/acme/product/capture/studies/${STUDY}?turnId=${TURN_2}`);
  });

  it("says the row came from research and how many turns it cites", () => {
    show([promoted]);
    expect(screen.getByTestId("evidence-provenance")).toHaveTextContent(/promoted from a research synthesis/i);
    expect(screen.getByTestId("evidence-provenance")).toHaveTextContent(/2 saved turns/i);
  });

  it("marks a cited turn that no longer resolves instead of linking it", () => {
    show([{
      ...promoted,
      research: {
        researchSynthesisId: promoted.research!.researchSynthesisId,
        sources: [
          promoted.research!.sources[0],
          { researchTurnId: TURN_2, studyId: null, sessionId: null, sequence: null, role: null, resolved: false },
        ],
      },
    }]);
    const block = screen.getByTestId("evidence-provenance");

    expect(within(block).getAllByRole("link")).toHaveLength(1);
    expect(block).toHaveTextContent(/no longer saved/i);
  });

  it("renders no provenance affordance at all for a row that was never promoted", () => {
    show([plain]);
    expect(screen.queryByTestId("evidence-provenance")).toBeNull();
    expect(screen.queryByText(/research synthesis/i)).toBeNull();
    expect(screen.queryByText(/saved turn/i)).toBeNull();
  });

  it("leaves a non-promoted row's markup identical whether or not a promoted row sits beside it", () => {
    const alone = show([plain]).container.querySelector('[data-evidence-id="plain-1"]')!.outerHTML;
    cleanup();
    const beside = show([promoted, plain]).container.querySelector('[data-evidence-id="plain-1"]')!.outerHTML;
    expect(beside).toBe(alone);
  });

  it("renders no participant transcript text, identity or credential material", () => {
    // The provenance type carries no such field, so this is a regression fence:
    // if a future change widens it, the UI must not start printing it.
    const leaky = {
      ...promoted,
      research: {
        ...promoted.research!,
        sources: [{
          ...promoted.research!.sources[0],
          content: "Participant said the export flow is unusable on mobile",
          participantName: "Dana-Participant-Realname",
          participantEmail: "dana@participant-pii.example",
          audioUrl: "s3://compass-private-audio/raw-recording.webm",
        }],
      },
    } as unknown as EvidenceListItem;

    const markup = show([leaky]).container.innerHTML;
    for (const secret of [
      "Participant said the export flow is unusable on mobile",
      "Dana-Participant-Realname",
      "dana@participant-pii.example",
      "s3://compass-private-audio/raw-recording.webm",
    ]) {
      expect(markup, `${secret} leaked`).not.toContain(secret);
    }
  });
});
