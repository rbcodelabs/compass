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
const mockFeedbackElementAnchor = { deleteMany: vi.fn() };
const mockFeedbackSourceToken = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockFeedbackSource = { deleteMany: vi.fn() };
const mockEmbedVisitorSession = { deleteMany: vi.fn() };
const mockEmbedAuthHandoff = { deleteMany: vi.fn() };
const mockCommentExternalAuthor = { updateMany: vi.fn() };
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
const mockWorkspaceCapabilityPack = { deleteMany: vi.fn() };
const mockCapabilityPack = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockCapabilityPackVersion = { findMany: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() };
const mockCanvasNodePosition = { deleteMany: vi.fn() };
const mockWorkspaceMember = { deleteMany: vi.fn() };
const mockSquad = { deleteMany: vi.fn() };
const mockDoc = { deleteMany: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) };
const mockArtifact = { findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() };
const mockArtifactRevision = { findMany: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() };
const mockArtifactLink = { deleteMany: vi.fn() };
const mockArtifactBlobCleanup = { upsert: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() };
const mockScoringModel = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockScoringModelMetric = { deleteMany: vi.fn() };
const mockReleaseDispatch = { deleteMany: vi.fn() };
const mockReleaseRunTask = { deleteMany: vi.fn() };
const mockReleaseRun = { deleteMany: vi.fn() };
const mockDecisionApplication = { deleteMany: vi.fn() };
const mockDecisionEvidenceRef = { deleteMany: vi.fn() };
const mockDecisionRecord = { deleteMany: vi.fn() };
const mockReviewOption = { deleteMany: vi.fn() };
const mockReviewRevision = { deleteMany: vi.fn() };
const mockReviewRequest = { updateMany: vi.fn(), deleteMany: vi.fn() };
const mockPortfolioCapacityReservation = { deleteMany: vi.fn() };
const mockPortfolioCapacityPlan = { deleteMany: vi.fn() };
const mockResearchDelete = { deleteMany: vi.fn(), updateMany: vi.fn() };

const mockPrisma = {
  docStorageObject: { findFirst: vi.fn().mockResolvedValue(null) },
  docOperation: { findFirst: vi.fn().mockResolvedValue(null) },
  workspaceUpdateEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  workspaceUpdatesReadState: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  workspaceUpdatesState: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  $transaction: vi.fn(),
  analyticsConnection: { deleteMany: vi.fn() },
  metricDefinition: { deleteMany: vi.fn() },
  metricRevision: { deleteMany: vi.fn() },
  metricBinding: { deleteMany: vi.fn() },
  metricObservation: { deleteMany: vi.fn() },
  workspaceActivationState: { deleteMany: vi.fn() },
  apiKey: { deleteMany: vi.fn() },
  agentMessage: { deleteMany: vi.fn() },
  agentAuditLog: { deleteMany: vi.fn() },
  agentConversation: { deleteMany: vi.fn() },
  agentWorkspaceGrant: { deleteMany: vi.fn() },
  agentToolCall: { deleteMany: vi.fn() },
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
  feedbackElementAnchor: mockFeedbackElementAnchor,
  feedbackSourceToken: mockFeedbackSourceToken,
  feedbackSource: mockFeedbackSource,
  embedVisitorSession: mockEmbedVisitorSession,
  embedAuthHandoff: mockEmbedAuthHandoff,
  commentExternalAuthor: mockCommentExternalAuthor,
  customFieldDefinition: mockCustomFieldDefinition,
  sharedFieldOptionSet: { deleteMany: vi.fn() },
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
  workspaceCapabilityPack: mockWorkspaceCapabilityPack,
  capabilityPack: mockCapabilityPack,
  capabilityPackVersion: mockCapabilityPackVersion,
  canvasNodePosition: mockCanvasNodePosition,
  workspaceMember: mockWorkspaceMember,
  squad: mockSquad,
  doc: mockDoc,
  artifact: mockArtifact,
  artifactRevision: mockArtifactRevision,
  artifactLink: mockArtifactLink,
  artifactBlobCleanup: mockArtifactBlobCleanup,
  scoringModel: mockScoringModel,
  scoringModelMetric: mockScoringModelMetric,
  releaseDispatch: mockReleaseDispatch,
  releaseRunTask: mockReleaseRunTask,
  releaseRun: mockReleaseRun,
  decisionApplication: mockDecisionApplication,
  decisionEvidenceRef: mockDecisionEvidenceRef,
  decisionRecord: mockDecisionRecord,
  reviewOption: mockReviewOption,
  reviewRevision: mockReviewRevision,
  reviewRequest: mockReviewRequest,
  portfolioCapacityReservation: mockPortfolioCapacityReservation,
  portfolioCapacityPlan: mockPortfolioCapacityPlan,
  researchVoiceCommand: mockResearchDelete,
  researchVoiceEvent: mockResearchDelete,
  researchVoiceCall: mockResearchDelete,
  researchRequest: mockResearchDelete,
  researchAttachment: mockResearchDelete,
  researchParticipantVoiceEvent: mockResearchDelete,
  researchTurn: mockResearchDelete,
  pMInterview: mockResearchDelete,
  researchSession: mockResearchDelete,
  researchParticipantToken: mockResearchDelete,
  researchSynthesis: mockResearchDelete,
  researchStudy: mockResearchDelete,
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
  mockFeedbackSourceToken.findMany.mockResolvedValue([{ id: "token-1" }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(operation => operation(mockPrisma));
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
    mockArtifactBlobCleanup,
    mockFeedbackSourceToken,
    mockCapabilityPack,
    mockCapabilityPackVersion,
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
    mockFeedbackElementAnchor.deleteMany,
    mockEmbedVisitorSession.deleteMany,
    mockEmbedAuthHandoff.deleteMany,
    mockCommentExternalAuthor.updateMany,
    mockFeedbackSourceToken.deleteMany,
    mockFeedbackSource.deleteMany,
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
    mockWorkspaceCapabilityPack.deleteMany,
    mockCapabilityPack.deleteMany,
    mockCapabilityPackVersion.deleteMany,
    mockCanvasNodePosition.deleteMany,
    mockWorkspaceMember.deleteMany,
    mockSquad.deleteMany,
    mockDoc.deleteMany,
    mockArtifact.updateMany,
    mockArtifact.deleteMany,
    mockArtifactRevision.deleteMany,
    mockArtifactLink.deleteMany,
    mockArtifactBlobCleanup.upsert,
    mockArtifactBlobCleanup.update,
    mockArtifactBlobCleanup.delete,
    mockScoringModel.deleteMany,
    mockScoringModelMetric.deleteMany,
  ]) {
    fn.mockResolvedValue({ count: 1 });
  }
});

describe("deleteOrganization", () => {
  it("returns a clean Unauthorized result when not signed in", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(deleteOrganization("acme", ORG_NAME)).resolves.toEqual({
      ok: false,
      error: "You are not signed in.",
    });
    expect(mockOrganization.delete).not.toHaveBeenCalled();
  });

  it("returns a clean result when caller is not an org member", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue(null);
    await expect(deleteOrganization("acme", ORG_NAME)).resolves.toEqual({
      ok: false,
      error: "Organization not found",
    });
    expect(mockOrganization.delete).not.toHaveBeenCalled();
  });

  it("rejects Forbidden when caller is a MEMBER, not an org admin", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "MEMBER", organizationId: "org-1" });
    await expect(deleteOrganization("acme", ORG_NAME)).resolves.toEqual({
      ok: false,
      error: "Forbidden: organization admin required",
    });
    expect(mockOrganization.delete).not.toHaveBeenCalled();
  });

  it("returns a result and deletes nothing when the confirmation name does not match", async () => {
    await expect(deleteOrganization("acme", "Wrong Name")).resolves.toEqual({
      ok: false,
      error: "Confirmation text does not match",
    });
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

    expect(result).toEqual({ ok: true, redirectTo: "/dashboard" });
    expect(mockOrganization.delete).toHaveBeenCalledWith({ where: { id: "org-1" } });
  });

  it("trims surrounding whitespace on the confirmation name", async () => {
    const result = await deleteOrganization("acme", `  ${ORG_NAME}  `);
    expect(result).toEqual({ ok: true, redirectTo: "/dashboard" });
    expect(mockOrganization.delete).toHaveBeenCalled();
  });

  it("cascades every table and returns { redirectTo: '/dashboard' } on the happy path", async () => {
    seedNonEmptyFindMany();
    mockCapabilityPack.findMany.mockResolvedValue([{ id: "pack-1" }]);
    mockCapabilityPackVersion.findMany.mockResolvedValue([
      { artifactPathname: "capability-packs/shared.json" },
    ]);

    const result = await deleteOrganization("acme", ORG_NAME);

    expect(mockPrisma.apiKey.deleteMany).toHaveBeenCalledWith({ where: { scopeWorkspaceId: "ws-1", scopeConversationId: { not: null } } });
    expect(mockPrisma.metricObservation.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: { in: ["ws-1"] } } });
    expect(mockPrisma.analyticsConnection.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: { in: ["ws-1"] } } });
    expect(mockResearchDelete.updateMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" }, data: { agentConversationId: null } });
    expect(mockPrisma.agentConversation.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
    expect(mockReleaseDispatch.deleteMany).toHaveBeenCalled();
    expect(mockReleaseRunTask.deleteMany).toHaveBeenCalled();
    expect(mockReleaseRun.deleteMany).toHaveBeenCalled();
    expect(mockDecisionApplication.deleteMany).toHaveBeenCalled();
    expect(mockDecisionEvidenceRef.deleteMany).toHaveBeenCalled();
    expect(mockDecisionRecord.deleteMany).toHaveBeenCalled();
    expect(mockReviewOption.deleteMany).toHaveBeenCalled();
    expect(mockReviewRevision.deleteMany).toHaveBeenCalled();
    expect(mockReviewRequest.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
    expect(mockPortfolioCapacityReservation.deleteMany).toHaveBeenCalled();
    expect(mockPortfolioCapacityPlan.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
    expect(mockReleaseRun.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(mockDecisionRecord.deleteMany.mock.invocationCallOrder[0]);
    expect(mockDecisionApplication.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(mockDecisionRecord.deleteMany.mock.invocationCallOrder[0]);
    expect(mockReviewRequest.updateMany.mock.invocationCallOrder[0]).toBeLessThan(mockReviewRevision.deleteMany.mock.invocationCallOrder[0]);
    expect(mockDecisionEvidenceRef.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(mockReviewRevision.deleteMany.mock.invocationCallOrder[0]);
    expect(mockReviewRevision.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(mockReviewRequest.deleteMany.mock.invocationCallOrder[0]);
    expect(mockReleaseRunTask.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(mockTask.deleteMany.mock.invocationCallOrder[0]);
    expect(mockPortfolioCapacityReservation.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(mockRoadmapItem.deleteMany.mock.invocationCallOrder[0]);

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
    expect(mockWorkspaceCapabilityPack.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
    expect(mockCapabilityPackVersion.deleteMany).toHaveBeenCalledWith({
      where: { capabilityPackId: { in: ["pack-1"] } },
    });
    expect(mockCapabilityPack.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["pack-1"] } } });

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
    expect(mockFeedbackElementAnchor.deleteMany).toHaveBeenCalledWith({
      where: { feedbackItemId: { in: ["fi-1"] } },
    });
    expect(mockFeedbackItem.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // ── Embed feedback sources ──
    // Visitor sessions and auth handoffs both carry a Restrict reference to
    // their source too — easy to miss, since a widget visitor only produces
    // them once someone actually signs in or starts to — so they must clear
    // before the source does, same as tokens. A bound source also carries a
    // reference to an artifact, so the whole group has to clear before
    // artifacts do.
    expect(mockEmbedVisitorSession.deleteMany).toHaveBeenCalledWith({
      where: { feedbackSource: { workspaceId: "ws-1" } },
    });
    expect(mockEmbedAuthHandoff.deleteMany).toHaveBeenCalledWith({
      where: { feedbackSource: { workspaceId: "ws-1" } },
    });
    // CommentExternalAuthor.embedTokenId has no @relation, so it dangles unless
    // nulled explicitly before the tokens it points at are deleted.
    expect(mockFeedbackSourceToken.findMany).toHaveBeenCalledWith({
      where: { feedbackSource: { workspaceId: "ws-1" } },
      select: { id: true },
    });
    expect(mockCommentExternalAuthor.updateMany).toHaveBeenCalledWith({
      where: { embedTokenId: { in: ["token-1"] } },
      data: { embedTokenId: null },
    });
    expect(mockFeedbackSourceToken.deleteMany).toHaveBeenCalledWith({
      where: { feedbackSource: { workspaceId: "ws-1" } },
    });
    expect(mockFeedbackSource.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // Order: sessions and handoffs before tokens, the nulling update before the
    // token delete it protects against, tokens before the source, and the whole
    // group before artifacts.
    expect(mockEmbedVisitorSession.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockFeedbackSourceToken.deleteMany.mock.invocationCallOrder[0]
    );
    expect(mockEmbedAuthHandoff.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockFeedbackSourceToken.deleteMany.mock.invocationCallOrder[0]
    );
    expect(mockCommentExternalAuthor.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockFeedbackSourceToken.deleteMany.mock.invocationCallOrder[0]
    );
    expect(mockFeedbackSourceToken.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockFeedbackSource.deleteMany.mock.invocationCallOrder[0]
    );
    expect(mockFeedbackSource.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockArtifact.deleteMany.mock.invocationCallOrder[0]
    );

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
    expect(result).toEqual({ ok: true, redirectTo: "/dashboard" });
  });

  it("skips the CommentExternalAuthor nulling update when the workspace has no embed tokens", async () => {
    // mockFeedbackSourceToken.findMany defaults to [] (not seeded via
    // seedNonEmptyFindMany in this test), so there is nothing to null out.
    mockWorkspace.findMany.mockResolvedValue([{ id: "ws-1" }]);
    await deleteOrganization("acme", ORG_NAME);
    expect(mockCommentExternalAuthor.updateMany).not.toHaveBeenCalled();
    // The rest of the embed-source cleanup still runs unconditionally.
    expect(mockEmbedVisitorSession.deleteMany).toHaveBeenCalledWith({
      where: { feedbackSource: { workspaceId: "ws-1" } },
    });
    expect(mockEmbedAuthHandoff.deleteMany).toHaveBeenCalledWith({
      where: { feedbackSource: { workspaceId: "ws-1" } },
    });
    expect(mockFeedbackSourceToken.deleteMany).toHaveBeenCalledWith({
      where: { feedbackSource: { workspaceId: "ws-1" } },
    });
  });
});
