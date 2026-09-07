// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { expect, it, vi } from "vitest";
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({ updateOpportunityStatus: vi.fn(), linkOpportunityToKeyResult: vi.fn() }));
vi.mock("@/components/custom-fields/custom-fields-panel", () => ({ CustomFieldsPanel: () => null }));
vi.mock("@/components/squads/squad-picker", () => ({ SquadPicker: () => null }));
vi.mock("@/components/discovery/evidence-list", () => ({ EvidenceList: () => null }));
vi.mock("@/components/discovery/add-evidence-dialog", () => ({ AddEvidenceDialog: () => null }));
import { OpportunityOverview } from "@/components/discovery/opportunity-overview";

it("renders the full opportunity description as Markdown", () => {
  render(<OpportunityOverview opportunity={{ id: "1", title: "Title", description: "One.\n\n- **Two**", customerSegment: null, status: "EXPLORING", createdAt: new Date("2026-01-01"), linkedKeyResult: null }} revalidatePathStr="/" />);
  expect(screen.getByText("One.").tagName).toBe("P");
  expect(screen.getByText("Two").tagName).toBe("STRONG");
});
