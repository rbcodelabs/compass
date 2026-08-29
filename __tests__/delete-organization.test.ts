import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Prisma mock ──────────────────────────────────────────────────────────────
// One flat mockPrisma object with every accessor deleteOrganization touches.
// Mirrors the shape in __tests__/actions/settings.test.ts.

const mockOrganization = { findUnique: vi.fn(), delete: vi.fn() };
const mockOrganizationMember = { findFirst: vi.fn(), deleteMany: vi.fn() };
const mockWorkspace = { findMany: vi.fn(), delete: vi.fn() };
const mockObjective = { updateMany: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() };
const mockExperiment = { updateMany: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() };
const mockTask = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockTaskLink = { deleteMany: vi.fn() };
const mockRoadmapItem = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockLaunchChecklist = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockLaunchChecklistItem = { deleteMany: vi.fn() };
const mockChecklistTemplate = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockChecklistTemplateItem = { deleteMany: vi.fn() };
const mockRoadmapVote = { deleteMany: vi.fn() };
const mockFeedbackItem = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockFeedbackVote = { deleteMany: vi.fn() };
const mockFeedbackAttachment = { deleteMany: vi.fn() };
const mockCustomFieldDefinition = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockCustomFieldValue = { deleteMany: vi.fn() };
const mockEvidence = { deleteMany: vi.fn() };
const mockOpportunity = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockOpportunityScore = { deleteMany: vi.fn() };
const mockSolution = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockAssumption = { deleteMany: vi.fn() };
const mockSolutionComment = { deleteMany: vi.fn() };
const mockExperimentResult = { deleteMany: vi.fn() };
const mockOKRCycle = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockKeyResult = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockCheckIn = { deleteMany: vi.fn() };
const mockWorkspaceScoringConfig = { deleteMany: vi.fn() };
const mockCanvasNodePosition = { deleteMany: vi.fn() };
const mockWorkspaceMember = { deleteMany: vi.fn() };
const mockSquad = { deleteMany: vi.fn() };
const mockDoc = { deleteMany: vi.fn() };
const mockArtifact = { findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() };
const mockArtifactRevision = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockArtifactLink = { deleteMany: vi.fn() };
const mockScoringModel = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockScoringModelMetric = { deleteMany: vi.fn() };

const mockPrisma = {
  organization: mockOrganization,
  organizationMember: mockOrganizationMember,
  workspace: mockWorkspace,
  objective: mockObjective,
  experiment: mockExperiment,
  task: mockTask,
  taskLink: mockTaskLink,
  roadmapItem: mockRoadmapItem,
  launchChecklist: mockLaunchChecklist,
  launchChecklistItem: mockLaunchChecklistItem,
  checklistTemplate: mockChecklistTemplate,
  checklistTemplateItem: mockChecklistTemplateItem,
  roadmapVote: mockRoadmapVote,
  feedbackItem: mockFeedbackItem,
  feedbackVote: mockFeedbackVote,
  feedbackAttachment: mockFeedbackAttachment,
  customFieldDefinition: mockCustomFieldDefinition,
  customFieldValue: mockCustomFieldValue,
  evidence: mockEvidence,
  opportunity: mockOpportunity,
  opportunityScore: mockOpportunityScore,
  solution: mockSolution,
  assumption: mockAssumption,
  solutionComment: mockSolutionComment,
  experimentResult: mockExperimentResult,
  oKRCycle: mockOKRCycle,
  keyResult: mockKeyResult,
  checkIn: mockCheckIn,
  workspaceScoringConfig: mockWorkspaceScoringConfig,
  canvasNodePosition: mockCanvasNodePosition,
  workspaceMember: mockWorkspaceMember,
  squad: mockSquad,
  doc: mockDoc,
  artifact: mockArtifact,
  artifactRevision: mockArtifactRevision,
  artifactLink: mockArtifactLink,
  scoringModel: mockScoringModel,
  scoringModelMetric: mockScoringModelMetric,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { deleteOrganization } from "@/app/[orgSlug]/settings/actions";

const mockAuth = vi.mocked(auth);

const ORG_NAME = "Acme Corp";

/** Every findMany returns non-empty so the "by id set" branches execute. */
function seedNonEmptyFindMany() {
  mockWorkspace.findMany.mockResolvedValue([{ id: "ws-1" }]);
  mockTask.findMany.mockResolvedValue([{ id: "task-1" }]);
  mockRoadmapItem.findMany.mockResolvedValue([{ id: "ri-1" }]);
  mockLaunchChecklist.findMany.mockResolvedValue([{ id: "lc-1" }]);
  mockChecklistTemplate.findMany.mockResolvedValue([{ id: "ct-1" }]);
  mockFeedbackItem.findMany.mockResolvedValue([{ id: "fi-1" }]);
  mockCustomFieldDefinition.findMany.mockResolvedValue([{ id: "cf-1" }]);
  mockOpportunity.findMany.mockResolvedValue([{ id: "opp-1" }]);
  mockSolution.findMany.mockResolvedValue([{ id: "sol-1" }]);
  mockExperiment.findMany.mockResolvedValue([{ id: "exp-1" }]);
  mockOKRCycle.findMany.mockResolvedValue([{ id: "cycle-1" }]);
  mockObjective.findMany.mockResolvedValue([{ id: "obj-1" }]);
  mockKeyResult.findMany.mockResolvedValue([{ id: "kr-1" }]);
  mockScoringModel.findMany.mockResolvedValue([{ id: "sm-1" }]);
  mockArtifact.findMany.mockResolvedValue([{ id: "art-1" }]);
  mockArtifactRevision.findMany.mockResolvedValue([{ blobPathname: null }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Authenticated by default.
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as ReturnType<typeof auth> extends Promise<infer T>
    ? T
    : never);
  // resolveOrgAdmin: caller is an OWNER of org-1.
  mockOrganizationMember.findFirst.mockResolvedValue({ role: "OWNER", organizationId: "org-1" });
  // Org exists with the confirm name.
  mockOrganization.findUnique.mockResolvedValue({ name: ORG_NAME });

  // Every findMany empty unless a test opts into seedNonEmptyFindMany().
  for (const m of [
    mockWorkspace,
    mockTask,
    mockRoadmapItem,
    mockLaunchChecklist,
    mockChecklistTemplate,
    mockFeedbackItem,
    mockCustomFieldDefinition,
    mockOpportunity,
    mockSolution,
    mockExperiment,
    mockOKRCycle,
    mockObjective,
    mockKeyResult,
    mockScoringModel,
    mockArtifact,
    mockArtifactRevision,
  ]) {
    m.findMany.mockResolvedValue([]);
  }

  // Every write resolves.
  for (const fn of [
    mockOrganization.delete,
    mockOrganizationMember.deleteMany,
    mockWorkspace.delete,
    mockObjective.updateMany,
    mockObjective.deleteMany,
    mockExperiment.updateMany,
    mockExperiment.deleteMany,
    mockTask.deleteMany,
    mockTaskLink.deleteMany,
    mockRoadmapItem.deleteMany,
    mockLaunchChecklist.deleteMany,
    mockLaunchChecklistItem.deleteMany,
    mockChecklistTemplate.deleteMany,
    mockChecklistTemplateItem.deleteMany,
    mockRoadmapVote.deleteMany,
    mockFeedbackItem.deleteMany,
    mockFeedbackVote.deleteMany,
    mockFeedbackAttachment.deleteMany,
    mockCustomFieldDefinition.deleteMany,
    mockCustomFieldValue.deleteMany,
    mockEvidence.deleteMany,
    mockOpportunity.deleteMany,
    mockOpportunityScore.deleteMany,
    mockSolution.deleteMany,
    mockAssumption.deleteMany,
    mockSolutionComment.deleteMany,
    mockExperimentResult.deleteMany,
    mockOKRCycle.deleteMany,
    mockKeyResult.deleteMany,
    mockCheckIn.deleteMany,
    mockWorkspaceScoringConfig.deleteMany,
    mockCanvasNodePosition.deleteMany,
    mockWorkspaceMember.deleteMany,
    mockSquad.deleteMany,
    mockDoc.deleteMany,
    mockArtifact.updateMany,
    mockArtifact.deleteMany,
    mockArtifactRevision.deleteMany,
    mockArtifactLink.deleteMany,
    mockScoringModel.deleteMany,
    mockScoringModelMetric.deleteMany,
  ]) {
    fn.mockResolvedValue({ count: 1 });
  }
});

describe("deleteOrganization", () => {
  it("rejects Unauthorized when not signed in", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(deleteOrganization("acme", ORG_NAME)).rejects.toThrow("Unauthorized");
    expect(mockOrganization.delete).not.toHaveBeenCalled();
  });

  it("rejects Organization not found when caller is not an org member", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue(null);
    await expect(deleteOrganization("acme", ORG_NAME)).rejects.toThrow("Organization not found");
    expect(mockOrganization.delete).not.toHaveBeenCalled();
  });

  it("rejects Forbidden when caller is a MEMBER, not an org admin", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "MEMBER", organizationId: "org-1" });
    await expect(deleteOrganization("acme", ORG_NAME)).rejects.toThrow(
      "Forbidden: organization admin required"
    );
    expect(mockOrganization.delete).not.toHaveBeenCalled();
  });

  it("rejects and deletes nothing when the confirmation name does not match", async () => {
    await expect(deleteOrganization("acme", "Wrong Name")).rejects.toThrow(
      "Confirmation text does not match"
    );
    // No destructive call of any kind should have fired.
    expect(mockWorkspace.delete).not.toHaveBeenCalled();
    expect(mockOrganization.delete).not.toHaveBeenCalled();
    expect(mockOrganizationMember.deleteMany).not.toHaveBeenCalled();
    expect(mockScoringModel.deleteMany).not.toHaveBeenCalled();
    expect(mockTask.deleteMany).not.toHaveBeenCalled();
  });

  it("allows an ADMIN (not just OWNER) to delete", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "ADMIN", organizationId: "org-1" });
    const result = await deleteOrganization("acme", ORG_NAME);
    expect(result).toEqual({ redirectTo: "/dashboard" });
    expect(mockOrganization.delete).toHaveBeenCalledWith({ where: { id: "org-1" } });
  });

  it("trims surrounding whitespace on the confirmation name", async () => {
    const result = await deleteOrganization("acme", `  ${ORG_NAME}  `);
    expect(result).toEqual({ redirectTo: "/dashboard" });
    expect(mockOrganization.delete).toHaveBeenCalled();
  });

  it("cascades every table and returns { redirectTo: '/dashboard' } on the happy path", async () => {
    seedNonEmptyFindMany();

    const result = await deleteOrganization("acme", ORG_NAME);

    // ── Per-workspace: null-out steps ──
    expect(mockObjective.updateMany).toHaveBeenCalledWith({
      where: { cycle: { workspaceId: "ws-1" } },
      data: { parentKeyResultId: null },
    });
    expect(mockExperiment.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      data: { assumptionId: null },
    });
    expect(mockArtifactLink.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
    expect(mockArtifact.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      data: { currentRevisionId: null, updatedAt: expect.any(Date) },
    });
    expect(mockArtifactRevision.deleteMany).toHaveBeenCalledWith({
      where: { artifactId: { in: ["art-1"] } },
    });
    expect(mockArtifact.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // ── Tasks / TaskLinks ──
    expect(mockTaskLink.deleteMany).toHaveBeenCalledWith({ where: { taskId: { in: ["task-1"] } } });
    expect(mockTask.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // ── Launch checklists / templates ──
    expect(mockLaunchChecklistItem.deleteMany).toHaveBeenCalledWith({
      where: { launchChecklistId: { in: ["lc-1"] } },
    });
    expect(mockLaunchChecklist.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["lc-1"] } } });
    expect(mockChecklistTemplateItem.deleteMany).toHaveBeenCalledWith({
      where: { checklistTemplateId: { in: ["ct-1"] } },
    });
    expect(mockChecklistTemplate.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // ── Roadmap ──
    expect(mockRoadmapVote.deleteMany).toHaveBeenCalledWith({
      where: { roadmapItemId: { in: ["ri-1"] } },
    });
    expect(mockRoadmapItem.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // ── Feedback ──
    expect(mockFeedbackVote.deleteMany).toHaveBeenCalledWith({ where: { feedbackId: { in: ["fi-1"] } } });
    expect(mockFeedbackAttachment.deleteMany).toHaveBeenCalledWith({
      where: { feedbackItemId: { in: ["fi-1"] } },
    });
    expect(mockFeedbackItem.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // ── Custom fields ──
    expect(mockCustomFieldValue.deleteMany).toHaveBeenCalledWith({ where: { fieldId: { in: ["cf-1"] } } });
    expect(mockCustomFieldDefinition.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // ── Evidence ──
    expect(mockEvidence.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // ── Opportunity subtree ──
    expect(mockOpportunityScore.deleteMany).toHaveBeenCalledWith({
      where: { opportunityId: { in: ["opp-1"] } },
    });
    expect(mockAssumption.deleteMany).toHaveBeenCalledWith({ where: { solutionId: { in: ["sol-1"] } } });
    expect(mockSolutionComment.deleteMany).toHaveBeenCalledWith({
      where: { solutionId: { in: ["sol-1"] } },
    });
    expect(mockSolution.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["sol-1"] } } });
    expect(mockOpportunity.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // ── Experiments ──
    expect(mockExperimentResult.deleteMany).toHaveBeenCalledWith({
      where: { experimentId: { in: ["exp-1"] } },
    });
    expect(mockExperiment.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // ── OKR subtree ──
    expect(mockCheckIn.deleteMany).toHaveBeenCalledWith({ where: { keyResultId: { in: ["kr-1"] } } });
    expect(mockKeyResult.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["kr-1"] } } });
    expect(mockObjective.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["obj-1"] } } });
    expect(mockOKRCycle.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // ── Workspace singletons ──
    expect(mockWorkspaceScoringConfig.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
    expect(mockCanvasNodePosition.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // ── Members / squads / docs / workspace ──
    expect(mockWorkspaceMember.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
    expect(mockSquad.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
    expect(mockDoc.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
    expect(mockWorkspace.delete).toHaveBeenCalledWith({ where: { id: "ws-1" } });

    // ── Org-level ──
    expect(mockScoringModelMetric.deleteMany).toHaveBeenCalledWith({
      where: { scoringModelId: { in: ["sm-1"] } },
    });
    expect(mockScoringModel.deleteMany).toHaveBeenCalledWith({ where: { organizationId: "org-1" } });
    expect(mockOrganizationMember.deleteMany).toHaveBeenCalledWith({ where: { organizationId: "org-1" } });
    expect(mockOrganization.delete).toHaveBeenCalledWith({ where: { id: "org-1" } });

    // ── Revalidation + return ──
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(result).toEqual({ redirectTo: "/dashboard" });
  });
});
