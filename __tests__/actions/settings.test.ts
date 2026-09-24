import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSquad = {
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  deleteMany: vi.fn(),
};
const mockWorkspace = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
const mockObjective = {
  updateMany: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  update: vi.fn(),
};
const mockOpportunity = {
  updateMany: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  update: vi.fn(),
};
const mockExperiment = {
  updateMany: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  update: vi.fn(),
};
const mockRoadmapItem = {
  update: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
};
const mockCustomFieldDefinition = {
  count: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  update: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
};
const mockCustomFieldValue = {
  deleteMany: vi.fn(),
  upsert: vi.fn(),
};
const mockApiKey = {
  deleteMany: vi.fn(),
  create: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
};
const mockOrganization = {
  findUnique: vi.fn(),
  delete: vi.fn(),
};
const mockOrganizationMember = { deleteMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() };
const mockUser = { upsert: vi.fn() };
const mockOKRCycle = {
  findMany: vi.fn(),
  deleteMany: vi.fn(),
};
const mockKeyResult = {
  findMany: vi.fn(),
  deleteMany: vi.fn(),
};
const mockCheckIn = { deleteMany: vi.fn() };
const mockExperimentResult = { deleteMany: vi.fn() };
const mockFeedbackItem = {
  findMany: vi.fn(),
  deleteMany: vi.fn(),
};
const mockFeedbackVote = { deleteMany: vi.fn() };
const mockRoadmapVote = { deleteMany: vi.fn() };
const mockSolution = {
  findMany: vi.fn(),
  deleteMany: vi.fn(),
};
const mockAssumption = { deleteMany: vi.fn() };
const mockSolutionComment = { deleteMany: vi.fn() };
const mockWorkspaceMember = {
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
};
const mockDoc = { deleteMany: vi.fn() };
const mockArtifact = { findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() };
const mockArtifactRevision = { findMany: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() };
const mockArtifactLink = { deleteMany: vi.fn() };
const mockArtifactBlobCleanup = { upsert: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() };
const mockWorkspaceScoringConfig = { upsert: vi.fn() };
const mockWorkspaceCapabilityPack = { deleteMany: vi.fn() };
const mockCapabilityPack = { findMany: vi.fn(), deleteMany: vi.fn() };
const mockCapabilityPackVersion = { findMany: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() };
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
  workspaceUpdateEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  workspaceUpdatesReadState: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  workspaceUpdatesState: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  analyticsConnection: { deleteMany: vi.fn() },
  metricDefinition: { deleteMany: vi.fn() },
  metricRevision: { deleteMany: vi.fn() },
  metricBinding: { deleteMany: vi.fn() },
  metricObservation: { deleteMany: vi.fn() },
  workspaceActivationState: { deleteMany: vi.fn() },
  agentMessage: { deleteMany: vi.fn() },
  agentAuditLog: { deleteMany: vi.fn() },
  agentConversation: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
  agent: { findMany: vi.fn().mockResolvedValue([]) },
  agentWorkspaceGrant: { deleteMany: vi.fn(), updateMany: vi.fn() },
  agentToolCall: { deleteMany: vi.fn() },
  squad: mockSquad,
  workspace: mockWorkspace,
  objective: mockObjective,
  opportunity: mockOpportunity,
  experiment: mockExperiment,
  roadmapItem: mockRoadmapItem,
  customFieldDefinition: mockCustomFieldDefinition,
  customFieldValue: mockCustomFieldValue,
  sharedFieldOptionSet: { deleteMany: vi.fn() },
  apiKey: mockApiKey,
  organization: mockOrganization,
  organizationMember: mockOrganizationMember,
  user: mockUser,
  oKRCycle: mockOKRCycle,
  keyResult: mockKeyResult,
  checkIn: mockCheckIn,
  experimentResult: mockExperimentResult,
  feedbackItem: mockFeedbackItem,
  feedbackVote: mockFeedbackVote,
  roadmapVote: mockRoadmapVote,
  solution: mockSolution,
  assumption: mockAssumption,
  solutionComment: mockSolutionComment,
  workspaceMember: mockWorkspaceMember,
  doc: mockDoc,
  artifact: mockArtifact,
  artifactRevision: mockArtifactRevision,
  artifactLink: mockArtifactLink,
  artifactBlobCleanup: mockArtifactBlobCleanup,
  workspaceScoringConfig: mockWorkspaceScoringConfig,
  workspaceCapabilityPack: mockWorkspaceCapabilityPack,
  capabilityPack: mockCapabilityPack,
  capabilityPackVersion: mockCapabilityPackVersion,
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

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import {
  createSquad,
  updateSquad,
  deleteSquad,
  assignSquad,
  createFieldDefinition,
  deleteFieldDefinition,
  updateFieldDefinition,
  upsertFieldValue,
  createApiKey,
  revokeApiKey,
  updatePortalSettings,
  updateWorkspaceBranding,
  updateWorkspaceLimits,
  deleteWorkspace,
  addWorkspaceMember,
  updateWorkspaceMemberRole,
  removeWorkspaceMember,
  setActiveScoringModel,
} from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";

const mockAuth = vi.mocked(auth);

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation((operation) => operation(mockPrisma));
  mockWorkspaceMember.updateMany.mockResolvedValue({ count: 1 });
  // Default: authenticated
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
  // resolveWorkspace always finds the workspace
  mockWorkspace.findFirst.mockResolvedValue({ id: "ws-1" });
  mockWorkspace.update.mockResolvedValue({ id: "ws-1" });
  mockSquad.create.mockResolvedValue({ id: "squad-1" });
  mockSquad.update.mockResolvedValue({ id: "squad-1" });
  mockSquad.delete.mockResolvedValue({ id: "squad-1" });
  mockObjective.updateMany.mockResolvedValue({ count: 0 });
  mockOpportunity.updateMany.mockResolvedValue({ count: 0 });
  mockExperiment.updateMany.mockResolvedValue({ count: 0 });
  mockRoadmapItem.updateMany.mockResolvedValue({ count: 0 });
  mockCustomFieldDefinition.count.mockResolvedValue(0);
  mockCustomFieldDefinition.create.mockResolvedValue({ id: "field-1" });
  mockCustomFieldDefinition.delete.mockResolvedValue({ id: "field-1" });
  mockCustomFieldDefinition.update.mockResolvedValue({ id: "field-1" });
  mockCustomFieldValue.deleteMany.mockResolvedValue({ count: 0 });
  mockCustomFieldValue.upsert.mockResolvedValue({ id: "val-1" });
  mockApiKey.create.mockResolvedValue({ id: "key-1" });
  mockApiKey.findFirst.mockResolvedValue({ id: "key-1", keyHash: "hash", keyPrefix: "pref" });
  mockApiKey.update.mockResolvedValue({ id: "key-1" });
  mockWorkspaceScoringConfig.upsert.mockResolvedValue({ id: "config-1" });
  mockArtifact.findMany.mockResolvedValue([]);
  mockArtifactRevision.findMany.mockResolvedValue([]);
  mockArtifactRevision.findFirst.mockResolvedValue(null);
  mockArtifact.updateMany.mockResolvedValue({ count: 0 });
  mockArtifact.deleteMany.mockResolvedValue({ count: 0 });
  mockArtifactRevision.deleteMany.mockResolvedValue({ count: 0 });
  mockArtifactLink.deleteMany.mockResolvedValue({ count: 0 });
  mockArtifactBlobCleanup.findMany.mockResolvedValue([]);
  mockArtifactBlobCleanup.upsert.mockResolvedValue({ id: "cleanup-1" });
  mockCapabilityPack.findMany.mockResolvedValue([]);
  mockCapabilityPackVersion.findMany.mockResolvedValue([]);
  mockCapabilityPackVersion.findFirst.mockResolvedValue(null);
  mockWorkspaceMember.findMany.mockResolvedValue([{ role: "ADMIN" }, { role: "ADMIN" }]);

  // deleteWorkspace defaults. The members/organization selections are what
  // resolveWorkspaceAdmin reads. Member management is now gated on workspace
  // admin, so the default caller in these tests is a workspace ADMIN.
  mockWorkspace.findFirst.mockResolvedValue({
    id: "ws-1",
    organizationId: "org-1",
    members: [{ role: "ADMIN" }],
    organization: { members: [{ role: "MEMBER" }] },
  });
  mockWorkspace.delete.mockResolvedValue({ id: "ws-1" });
  // After deletion: one remaining workspace in the org
  mockWorkspace.findMany.mockResolvedValue([{ id: "ws-2", slug: "other-ws" }]);
  mockOrganization.findUnique.mockResolvedValue({ slug: "my-org" });
  mockOrganization.delete.mockResolvedValue({ id: "org-1" });
  mockOrganizationMember.deleteMany.mockResolvedValue({ count: 0 });
  // OKR chain: no cycles by default
  mockOKRCycle.findMany.mockResolvedValue([]);
  mockOKRCycle.deleteMany.mockResolvedValue({ count: 0 });
  mockKeyResult.findMany.mockResolvedValue([]);
  mockKeyResult.deleteMany.mockResolvedValue({ count: 0 });
  mockCheckIn.deleteMany.mockResolvedValue({ count: 0 });
  // Experiments
  mockExperiment.findMany.mockResolvedValue([]);
  mockExperiment.deleteMany.mockResolvedValue({ count: 0 });
  mockExperiment.updateMany.mockResolvedValue({ count: 0 });
  mockExperimentResult.deleteMany.mockResolvedValue({ count: 0 });
  // Roadmap
  mockRoadmapItem.findMany.mockResolvedValue([]);
  mockRoadmapItem.deleteMany.mockResolvedValue({ count: 0 });
  mockRoadmapVote.deleteMany.mockResolvedValue({ count: 0 });
  // Feedback
  mockFeedbackItem.findMany.mockResolvedValue([]);
  mockFeedbackItem.deleteMany.mockResolvedValue({ count: 0 });
  mockFeedbackVote.deleteMany.mockResolvedValue({ count: 0 });
  // Opportunity / Solution / Assumption
  mockOpportunity.findMany.mockResolvedValue([]);
  mockOpportunity.deleteMany.mockResolvedValue({ count: 0 });
  mockSolution.findMany.mockResolvedValue([]);
  mockSolution.deleteMany.mockResolvedValue({ count: 0 });
  mockAssumption.deleteMany.mockResolvedValue({ count: 0 });
  mockSolutionComment.deleteMany.mockResolvedValue({ count: 0 });
  // Custom fields
  mockCustomFieldDefinition.findMany.mockResolvedValue([]);
  mockCustomFieldDefinition.deleteMany.mockResolvedValue({ count: 0 });
  // Members / Squads / Docs
  mockWorkspaceMember.deleteMany.mockResolvedValue({ count: 0 });
  mockSquad.deleteMany.mockResolvedValue({ count: 0 });
  mockDoc.deleteMany.mockResolvedValue({ count: 0 });

  // Workspace member management defaults
  mockUser.upsert.mockResolvedValue({ id: "user-2", email: "new@example.com" });
  mockOrganizationMember.findFirst.mockResolvedValue(null);
  mockOrganizationMember.create.mockResolvedValue({ id: "org-member-1" });
  mockWorkspaceMember.findFirst.mockResolvedValue(null);
  mockWorkspaceMember.create.mockResolvedValue({ id: "ws-member-1" });
  mockWorkspaceMember.update.mockResolvedValue({ id: "ws-member-1" });
  mockWorkspaceMember.delete.mockResolvedValue({ id: "ws-member-1" });
  mockWorkspaceMember.count.mockResolvedValue(2);
});

// ─── createSquad ─────────────────────────────────────────────────────────────

describe("createSquad", () => {
  it("creates a squad with name and color", async () => {
    await createSquad("org", "ws", { name: "Alpha", color: "#ff0000" });
    expect(mockSquad.create).toHaveBeenCalledWith({
      data: { workspaceId: "ws-1", name: "Alpha", color: "#ff0000" },
    });
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      createSquad("org", "ws", { name: "Alpha", color: "#ff0000" })
    ).rejects.toThrow("Unauthorized");
    expect(mockSquad.create).not.toHaveBeenCalled();
  });

  it("throws Workspace not found when workspace does not exist", async () => {
    mockWorkspace.findFirst.mockResolvedValue(null);
    await expect(
      createSquad("org", "ws", { name: "Alpha", color: "#ff0000" })
    ).rejects.toThrow("Workspace not found");
  });

  it("throws Workspace not found when caller is not a member (resolveWorkspace scoping)", async () => {
    // resolveWorkspace scopes the lookup to `members: { some: { userId } } }` —
    // a non-member hitting a valid org/workspace slug pair must not pass.
    mockWorkspace.findFirst.mockResolvedValue(null);
    await expect(
      createSquad("org", "ws", { name: "Alpha", color: "#ff0000" })
    ).rejects.toThrow("Workspace not found");
    expect(mockWorkspace.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          members: { some: { userId: "user-1" } },
        }),
      })
    );
  });
});

// ─── updateSquad ─────────────────────────────────────────────────────────────

describe("updateSquad", () => {
  it("updates squad name", async () => {
    await updateSquad("org", "ws", "squad-1", { name: "Beta" });
    expect(mockSquad.update).toHaveBeenCalledWith({
      where: { id: "squad-1" },
      data: { name: "Beta" },
    });
  });

  it("updates squad color only when name is not provided", async () => {
    await updateSquad("org", "ws", "squad-1", { color: "#00ff00" });
    const data = mockSquad.update.mock.calls[0][0].data;
    expect(data.color).toBe("#00ff00");
    expect(data.name).toBeUndefined();
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      updateSquad("org", "ws", "squad-1", { name: "Beta" })
    ).rejects.toThrow("Unauthorized");
  });
});

// ─── deleteSquad ─────────────────────────────────────────────────────────────

describe("deleteSquad", () => {
  it("nulls out squad references before deleting", async () => {
    await deleteSquad("org", "ws", "squad-1");

    // All four related models should have been updated
    expect(mockObjective.updateMany).toHaveBeenCalledWith({
      where: { squadId: "squad-1" },
      data: { squadId: null },
    });
    expect(mockOpportunity.updateMany).toHaveBeenCalledWith({
      where: { squadId: "squad-1" },
      data: { squadId: null },
    });
    expect(mockExperiment.updateMany).toHaveBeenCalledWith({
      where: { squadId: "squad-1" },
      data: { squadId: null },
    });
    expect(mockRoadmapItem.updateMany).toHaveBeenCalledWith({
      where: { squadId: "squad-1" },
      data: { squadId: null, updatedAt: expect.any(Date) },
    });

    expect(mockSquad.delete).toHaveBeenCalledWith({ where: { id: "squad-1" } });
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(deleteSquad("org", "ws", "squad-1")).rejects.toThrow("Unauthorized");
    expect(mockSquad.delete).not.toHaveBeenCalled();
  });
});

// ─── assignSquad ─────────────────────────────────────────────────────────────

describe("assignSquad", () => {
  it("assigns squad to an objective", async () => {
    mockObjective.update = vi.fn().mockResolvedValue({ id: "obj-1" });
    mockPrisma.objective.update = mockObjective.update;
    await assignSquad("objective", "obj-1", "squad-1", "/path");
    expect(mockObjective.update).toHaveBeenCalledWith({
      where: { id: "obj-1" },
      data: { squadId: "squad-1" },
    });
  });

  it("bumps the roadmap item revision when assigning a squad", async () => {
    await assignSquad("roadmapItem", "roadmap-1", "squad-1", "/path");
    expect(mockRoadmapItem.update).toHaveBeenCalledWith({
      where: { id: "roadmap-1" },
      data: { squadId: "squad-1", updatedAt: expect.any(Date) },
    });
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      assignSquad("objective", "obj-1", "squad-1", "/path")
    ).rejects.toThrow("Unauthorized");
  });
});

// ─── createFieldDefinition ────────────────────────────────────────────────────

describe("createFieldDefinition", () => {
  it("creates a field with correct order (next after existing fields)", async () => {
    mockCustomFieldDefinition.count.mockResolvedValue(3);
    await createFieldDefinition("org", "ws", {
      objectType: "OPPORTUNITY",
      name: "Priority",
      fieldType: "SELECT",
    });
    const data = mockCustomFieldDefinition.create.mock.calls[0][0].data;
    expect(data.order).toBe(3); // count=3 means next index is 3
    expect(data.name).toBe("Priority");
    expect(data.fieldType).toBe("SELECT");
    expect(data.required).toBe(false);
  });

  it("passes options as InputJsonValue when provided", async () => {
    await createFieldDefinition("org", "ws", {
      objectType: "OPPORTUNITY",
      name: "Stage",
      fieldType: "SELECT",
      options: [{ label: "Active", value: "active" }],
    });
    const data = mockCustomFieldDefinition.create.mock.calls[0][0].data;
    expect(data.options).toEqual([{ label: "Active", value: "active" }]);
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      createFieldDefinition("org", "ws", {
        objectType: "OPPORTUNITY",
        name: "Priority",
        fieldType: "TEXT",
      })
    ).rejects.toThrow("Unauthorized");
  });
});

// ─── deleteFieldDefinition ────────────────────────────────────────────────────

describe("deleteFieldDefinition", () => {
  it("deletes values first then deletes the field definition", async () => {
    await deleteFieldDefinition("org", "ws", "field-1");
    expect(mockCustomFieldValue.deleteMany).toHaveBeenCalledWith({
      where: { fieldId: "field-1" },
    });
    expect(mockCustomFieldDefinition.delete).toHaveBeenCalledWith({
      where: { id: "field-1" },
    });
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      deleteFieldDefinition("org", "ws", "field-1")
    ).rejects.toThrow("Unauthorized");
    expect(mockCustomFieldDefinition.delete).not.toHaveBeenCalled();
  });
});

// ─── upsertFieldValue ─────────────────────────────────────────────────────────

describe("upsertFieldValue", () => {
  it("deletes when value is null", async () => {
    await upsertFieldValue("obj-1", "field-1", null, "/path");
    expect(mockCustomFieldValue.deleteMany).toHaveBeenCalledWith({
      where: { fieldId: "field-1", objectId: "obj-1" },
    });
    expect(mockCustomFieldValue.upsert).not.toHaveBeenCalled();
  });

  it("deletes when value is empty string", async () => {
    await upsertFieldValue("obj-1", "field-1", "", "/path");
    expect(mockCustomFieldValue.deleteMany).toHaveBeenCalled();
    expect(mockCustomFieldValue.upsert).not.toHaveBeenCalled();
  });

  it("deletes when value is empty array", async () => {
    await upsertFieldValue("obj-1", "field-1", [], "/path");
    expect(mockCustomFieldValue.deleteMany).toHaveBeenCalled();
    expect(mockCustomFieldValue.upsert).not.toHaveBeenCalled();
  });

  it("upserts when value is a non-empty string", async () => {
    await upsertFieldValue("obj-1", "field-1", "High Priority", "/path");
    expect(mockCustomFieldValue.upsert).toHaveBeenCalled();
    expect(mockCustomFieldValue.deleteMany).not.toHaveBeenCalled();
  });

  it("upserts when value is a number", async () => {
    await upsertFieldValue("obj-1", "field-1", 42, "/path");
    expect(mockCustomFieldValue.upsert).toHaveBeenCalled();
  });

  it("upserts when value is a boolean", async () => {
    await upsertFieldValue("obj-1", "field-1", true, "/path");
    expect(mockCustomFieldValue.upsert).toHaveBeenCalled();
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      upsertFieldValue("obj-1", "field-1", "value", "/path")
    ).rejects.toThrow("Unauthorized");
  });
});

// ─── createApiKey ─────────────────────────────────────────────────────────────

describe("createApiKey", () => {
  it("returns a rawKey starting with cmp_", async () => {
    const result = await createApiKey("org", "ws", "My Key");
    expect(result.rawKey).toMatch(/^cmp_[0-9a-f]{32}$/);
    expect(result.id).toBe("key-1");
  });

  it("creates the API key with name and hash in DB", async () => {
    await createApiKey("org", "ws", "My Key");
    const data = mockApiKey.create.mock.calls[0][0].data;
    expect(data.name).toBe("My Key");
    expect(data.keyHash).toBeDefined();
    expect(data.keyPrefix).toBeDefined();
    // keyHash should be a sha256 hex string (64 chars)
    expect(data.keyHash.length).toBe(64);
    // keyPrefix should be the first 8 chars of the random hex (after cmp_)
    expect(data.keyPrefix.length).toBe(8);
  });

  it("generates unique keys on each call", async () => {
    const result1 = await createApiKey("org", "ws", "Key 1");
    const result2 = await createApiKey("org", "ws", "Key 2");
    expect(result1.rawKey).not.toBe(result2.rawKey);
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(createApiKey("org", "ws", "Key")).rejects.toThrow("Unauthorized");
    expect(mockApiKey.create).not.toHaveBeenCalled();
  });

  it("throws Workspace not found when workspace lookup fails", async () => {
    mockWorkspace.findFirst.mockResolvedValue(null);
    await expect(createApiKey("org", "ws", "Key")).rejects.toThrow("Workspace not found");
  });
});

// ─── revokeApiKey ─────────────────────────────────────────────────────────────

describe("revokeApiKey", () => {
  it("sets revokedAt timestamp on the key", async () => {
    await revokeApiKey("org", "ws", "key-1");
    const data = mockApiKey.update.mock.calls[0][0].data;
    expect(data.revokedAt).toBeInstanceOf(Date);
  });

  it("throws Not found when key does not belong to user", async () => {
    mockApiKey.findFirst.mockResolvedValue(null);
    await expect(revokeApiKey("org", "ws", "key-999")).rejects.toThrow("Not found");
    expect(mockApiKey.update).not.toHaveBeenCalled();
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(revokeApiKey("org", "ws", "key-1")).rejects.toThrow("Unauthorized");
    expect(mockApiKey.update).not.toHaveBeenCalled();
  });
});

// ─── updatePortalSettings ─────────────────────────────────────────────────────

describe("updatePortalSettings", () => {
  it("enables feedback", async () => {
    await updatePortalSettings("org", "ws", { feedbackEnabled: true });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.feedbackEnabled).toBe(true);
  });

  it("disables feedback", async () => {
    await updatePortalSettings("org", "ws", { feedbackEnabled: false });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.feedbackEnabled).toBe(false);
  });

  it("makes roadmap public", async () => {
    await updatePortalSettings("org", "ws", { roadmapPublic: true });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.roadmapPublic).toBe(true);
  });

  it("skips undefined fields (does not overwrite with undefined)", async () => {
    // Only feedbackEnabled is provided — roadmapPublic should not appear
    await updatePortalSettings("org", "ws", { feedbackEnabled: true });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.roadmapPublic).toBeUndefined();
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      updatePortalSettings("org", "ws", { feedbackEnabled: true })
    ).rejects.toThrow("Unauthorized");
    expect(mockWorkspace.update).not.toHaveBeenCalled();
  });
});

// ─── updateWorkspaceBranding ────────────────────────────────────────────────

describe("updateWorkspaceBranding", () => {
  it("persists a preset palette selection and revalidates all 3 paths", async () => {
    await updateWorkspaceBranding("org", "ws", { paletteId: "emerald", primaryHex: null });

    const [args] = mockWorkspace.update.mock.calls[0];
    expect(args.where).toEqual({ id: "ws-1" });
    expect(args.data.brandingPaletteId).toBe("emerald");
    expect(args.data.brandingPrimaryHex).toBeNull();
    expect(args.data.updatedAt).toBeInstanceOf(Date);

    expect(revalidatePath).toHaveBeenCalledWith("/org/ws/settings");
    expect(revalidatePath).toHaveBeenCalledWith("/org/ws", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/portal/org/ws", "layout");
    expect(revalidatePath).toHaveBeenCalledTimes(3);
  });

  it("persists a valid custom hex color", async () => {
    await updateWorkspaceBranding("org", "ws", { primaryHex: "#4f3df2", paletteId: null });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.brandingPrimaryHex).toBe("#4f3df2");
    expect(data.brandingPaletteId).toBeNull();
  });

  it("persists a preset font selection", async () => {
    await updateWorkspaceBranding("org", "ws", { fontPresetId: "inter", fontFamily: null });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.brandingFontPresetId).toBe("inter");
  });

  it("persists a custom font family", async () => {
    await updateWorkspaceBranding("org", "ws", { fontFamily: "Roboto Slab", fontPresetId: null });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.brandingFontFamily).toBe("Roboto Slab");
  });

  it("persists a logo URL", async () => {
    await updateWorkspaceBranding("org", "ws", { logoUrl: "https://blob.example.com/logo.png" });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.brandingLogoUrl).toBe("https://blob.example.com/logo.png");
  });

  it("clears a logo when logoUrl is explicitly null", async () => {
    await updateWorkspaceBranding("org", "ws", { logoUrl: null });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.brandingLogoUrl).toBeNull();
  });

  it("omits fields that are undefined rather than overwriting with null", async () => {
    await updateWorkspaceBranding("org", "ws", { primaryHex: "#4f3df2" });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.brandingFontFamily).toBeUndefined();
    expect(data.brandingLogoUrl).toBeUndefined();
  });

  it("rejects a malformed hex and does not write to the DB", async () => {
    await expect(
      updateWorkspaceBranding("org", "ws", { primaryHex: "not-a-hex" })
    ).rejects.toThrow(/hex/i);
    expect(mockWorkspace.update).not.toHaveBeenCalled();
  });

  it("rejects a hex missing the leading #", async () => {
    await expect(
      updateWorkspaceBranding("org", "ws", { primaryHex: "4f3df2" })
    ).rejects.toThrow(/hex/i);
    expect(mockWorkspace.update).not.toHaveBeenCalled();
  });

  it("rejects a short hex (3-digit shorthand not supported)", async () => {
    await expect(
      updateWorkspaceBranding("org", "ws", { primaryHex: "#fff" })
    ).rejects.toThrow(/hex/i);
    expect(mockWorkspace.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown paletteId and does not write to the DB", async () => {
    await expect(
      updateWorkspaceBranding("org", "ws", { paletteId: "not-a-real-palette" })
    ).rejects.toThrow(/paletteId/i);
    expect(mockWorkspace.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown fontPresetId and does not write to the DB", async () => {
    await expect(
      updateWorkspaceBranding("org", "ws", { fontPresetId: "not-a-real-font" })
    ).rejects.toThrow(/fontPresetId/i);
    expect(mockWorkspace.update).not.toHaveBeenCalled();
  });

  it("rejects a font-name injection attempt containing a semicolon", async () => {
    await expect(
      updateWorkspaceBranding("org", "ws", { fontFamily: "Evil; } body { display:none" })
    ).rejects.toThrow(/fontFamily/i);
    expect(mockWorkspace.update).not.toHaveBeenCalled();
  });

  it("rejects a font-name injection attempt containing a closing style tag", async () => {
    await expect(
      updateWorkspaceBranding("org", "ws", { fontFamily: "</style><script>alert(1)</script>" })
    ).rejects.toThrow(/fontFamily/i);
    expect(mockWorkspace.update).not.toHaveBeenCalled();
  });

  it("rejects a font-name injection attempt containing a double quote", async () => {
    await expect(
      updateWorkspaceBranding("org", "ws", { fontFamily: 'Arial", "Comic Sans' })
    ).rejects.toThrow(/fontFamily/i);
    expect(mockWorkspace.update).not.toHaveBeenCalled();
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      updateWorkspaceBranding("org", "ws", { primaryHex: "#4f3df2" })
    ).rejects.toThrow("Unauthorized");
    expect(mockWorkspace.update).not.toHaveBeenCalled();
  });

  it("throws when the caller is not a member of the workspace", async () => {
    // resolveWorkspace scopes findFirst to workspaces the caller is a member
    // of — a non-member gets null back, same as a nonexistent workspace.
    mockWorkspace.findFirst.mockResolvedValue(null);
    await expect(
      updateWorkspaceBranding("org", "ws", { primaryHex: "#4f3df2" })
    ).rejects.toThrow("Workspace not found");
    expect(mockWorkspace.update).not.toHaveBeenCalled();
  });
});

// ─── updateWorkspaceLimits ──────────────────────────────────────────────────

describe("updateWorkspaceLimits", () => {
  it("persists a NOW limit", async () => {
    await updateWorkspaceLimits("org", "ws", { nowLimit: 4 });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.nowLimit).toBe(4);
  });

  it("persists a NEXT limit", async () => {
    await updateWorkspaceLimits("org", "ws", { nextLimit: 10 });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.nextLimit).toBe(10);
  });

  it("allows 0 as a valid limit", async () => {
    await updateWorkspaceLimits("org", "ws", { nowLimit: 0 });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.nowLimit).toBe(0);
  });

  it("clears a limit when explicitly set to null", async () => {
    await updateWorkspaceLimits("org", "ws", { nowLimit: null });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.nowLimit).toBeNull();
  });

  it("omits fields that are undefined rather than overwriting with null", async () => {
    await updateWorkspaceLimits("org", "ws", { nowLimit: 5 });
    const data = mockWorkspace.update.mock.calls[0][0].data;
    expect(data.nextLimit).toBeUndefined();
  });

  it("revalidates both settings and roadmap paths", async () => {
    await updateWorkspaceLimits("org", "ws", { nowLimit: 4 });
    expect(revalidatePath).toHaveBeenCalledWith("/org/ws/settings");
    expect(revalidatePath).toHaveBeenCalledWith("/org/ws/roadmap");
  });

  it("rejects a negative NOW limit and does not write to the DB", async () => {
    await expect(
      updateWorkspaceLimits("org", "ws", { nowLimit: -1 })
    ).rejects.toThrow(/nowLimit/i);
    expect(mockWorkspace.update).not.toHaveBeenCalled();
  });

  it("rejects a non-integer NEXT limit and does not write to the DB", async () => {
    await expect(
      updateWorkspaceLimits("org", "ws", { nextLimit: 2.5 })
    ).rejects.toThrow(/nextLimit/i);
    expect(mockWorkspace.update).not.toHaveBeenCalled();
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      updateWorkspaceLimits("org", "ws", { nowLimit: 4 })
    ).rejects.toThrow("Unauthorized");
    expect(mockWorkspace.update).not.toHaveBeenCalled();
  });
});

// ─── deleteWorkspace ──────────────────────────────────────────────────────────

describe("deleteWorkspace", () => {
  it("requires a workspace administrator before deleting analytics or any domain data", async () => {
    mockWorkspace.findFirst.mockResolvedValue({ id: "ws-1", organizationId: "org-1", members: [{ role: "MEMBER" }], organization: { members: [{ role: "MEMBER" }] } });
    await expect(deleteWorkspace("org", "ws")).rejects.toThrow("workspace admin required");
    expect(mockPrisma.metricObservation.deleteMany).not.toHaveBeenCalled();
    expect(mockWorkspace.delete).not.toHaveBeenCalled();
    expect(mockOpportunity.deleteMany).not.toHaveBeenCalled();
  });
  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(deleteWorkspace("org", "ws")).rejects.toThrow("Unauthorized");
    expect(mockWorkspace.delete).not.toHaveBeenCalled();
  });

  it("throws Workspace not found when workspace does not exist", async () => {
    // Override the first findFirst call (used by deleteWorkspace directly, not resolveWorkspace)
    mockWorkspace.findFirst.mockResolvedValue(null);
    await expect(deleteWorkspace("org", "ws")).rejects.toThrow("Workspace not found");
    expect(mockWorkspace.delete).not.toHaveBeenCalled();
  });

  it("deletes the workspace and all related data when authenticated", async () => {
    // Set up workspace with data to delete
    mockWorkspace.findFirst.mockResolvedValue({ id: "ws-1", organizationId: "org-1", members: [{ role: "ADMIN" }] });

    // Roadmap items exist
    mockRoadmapItem.findMany.mockResolvedValue([{ id: "ri-1" }]);
    // Feedback items exist
    mockFeedbackItem.findMany.mockResolvedValue([{ id: "fi-1" }]);
    // Custom fields exist
    mockCustomFieldDefinition.findMany.mockResolvedValue([{ id: "cf-1" }]);
    // Opportunities with solutions and assumptions
    mockOpportunity.findMany.mockResolvedValue([{ id: "opp-1" }]);
    mockSolution.findMany.mockResolvedValue([{ id: "sol-1" }]);
    // Experiments exist
    mockExperiment.findMany.mockResolvedValue([{ id: "exp-1" }]);
    // OKR chain
    mockOKRCycle.findMany.mockResolvedValue([{ id: "cycle-1" }]);
    mockObjective.findMany.mockResolvedValue([{ id: "obj-1" }]);
    mockKeyResult.findMany.mockResolvedValue([{ id: "kr-1" }]);
    mockCapabilityPack.findMany.mockResolvedValue([{ id: "pack-1" }]);
    mockCapabilityPackVersion.findMany.mockResolvedValue([
      { artifactPathname: "capability-packs/shared.json" },
    ]);

    // One remaining workspace after deletion
    mockWorkspace.findMany.mockResolvedValue([{ id: "ws-2", slug: "other-ws" }]);

    const result = await deleteWorkspace("org", "ws");

    expect(mockPrisma.metricObservation.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: { in: ["ws-1"] } } });
    expect(mockPrisma.analyticsConnection.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: { in: ["ws-1"] } } });

    expect(mockApiKey.deleteMany).toHaveBeenCalledWith({ where: { scopeWorkspaceId: "ws-1", scopeConversationId: { not: null } } });
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
    expect(mockPortfolioCapacityReservation.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(mockRoadmapItem.deleteMany.mock.invocationCallOrder[0]);

    // Workspace deleted
    expect(mockWorkspace.delete).toHaveBeenCalledWith({ where: { id: "ws-1" } });

    // Roadmap votes deleted before roadmap items
    expect(mockRoadmapVote.deleteMany).toHaveBeenCalledWith({
      where: { roadmapItemId: { in: ["ri-1"] } },
    });
    expect(mockRoadmapItem.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // Feedback votes deleted before feedback items
    expect(mockFeedbackVote.deleteMany).toHaveBeenCalledWith({
      where: { feedbackId: { in: ["fi-1"] } },
    });
    expect(mockFeedbackItem.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // Custom field values deleted before definitions
    expect(mockCustomFieldValue.deleteMany).toHaveBeenCalledWith({
      where: { fieldId: { in: ["cf-1"] } },
    });
    expect(mockCustomFieldDefinition.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
    });

    // Assumptions and solution comments deleted before solutions, before opportunities
    expect(mockAssumption.deleteMany).toHaveBeenCalledWith({
      where: { solutionId: { in: ["sol-1"] } },
    });
    expect(mockSolutionComment.deleteMany).toHaveBeenCalledWith({
      where: { solutionId: { in: ["sol-1"] } },
    });
    expect(mockSolution.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["sol-1"] } },
    });
    expect(mockOpportunity.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // Experiment results deleted before experiments
    expect(mockExperimentResult.deleteMany).toHaveBeenCalledWith({
      where: { experimentId: { in: ["exp-1"] } },
    });
    expect(mockExperiment.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    // Check-ins deleted before key results, objectives deleted before cycles
    expect(mockCheckIn.deleteMany).toHaveBeenCalledWith({
      where: { keyResultId: { in: ["kr-1"] } },
    });
    expect(mockKeyResult.deleteMany).toHaveBeenCalledWith({
      where: { objectiveId: { in: ["obj-1"] } },
    });
    expect(mockOKRCycle.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });

    expect(mockWorkspaceCapabilityPack.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
    expect(mockCapabilityPackVersion.deleteMany).toHaveBeenCalledWith({
      where: { capabilityPackId: { in: ["pack-1"] } },
    });
    expect(mockCapabilityPack.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["pack-1"] } } });
    expect(mockCapabilityPackVersion.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockCapabilityPack.deleteMany.mock.invocationCallOrder[0]
    );

    // Returns a redirect to the remaining workspace
    expect(result.redirectTo).toBe("/my-org/other-ws");
  });

  it("deletes the org when no workspaces remain after deletion", async () => {
    mockWorkspace.findFirst.mockResolvedValue({ id: "ws-1", organizationId: "org-1", members: [{ role: "ADMIN" }] });
    // No remaining workspaces after deletion
    mockWorkspace.findMany.mockResolvedValue([]);

    const result = await deleteWorkspace("org", "ws");

    expect(mockOrganizationMember.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1" },
    });
    expect(mockOrganization.delete).toHaveBeenCalledWith({ where: { id: "org-1" } });
    expect(result.redirectTo).toBe("/");
  });

  it("does not delete the org when other workspaces remain", async () => {
    mockWorkspace.findFirst.mockResolvedValue({ id: "ws-1", organizationId: "org-1", members: [{ role: "ADMIN" }] });
    mockWorkspace.findMany.mockResolvedValue([{ id: "ws-2", slug: "other-ws" }]);

    await deleteWorkspace("org", "ws");

    expect(mockOrganization.delete).not.toHaveBeenCalled();
    expect(mockOrganizationMember.deleteMany).not.toHaveBeenCalled();
  });
});

// ─── addWorkspaceMember ────────────────────────────────────────────────────────

/**
 * Resolves the workspace with the caller holding the given workspace role and
 * org role. addWorkspaceMember, updateWorkspaceMemberRole and
 * removeWorkspaceMember are gated by resolveWorkspaceAdmin, which reads both.
 */
function mockCallerRoles(role = "ADMIN", orgRole = "MEMBER") {
  mockWorkspace.findFirst.mockResolvedValue({
    id: "ws-1",
    organizationId: "org-1",
    members: [{ role }],
    organization: { members: [{ role: orgRole }] },
  });
}

describe("addWorkspaceMember", () => {
  it("upserts the user by email, creates an org member, and creates a workspace member", async () => {
    mockUser.upsert.mockResolvedValue({ id: "user-2", email: "new@example.com" });

    await addWorkspaceMember("org", "ws", { email: "New@Example.com  ", role: "MEMBER" });

    expect(mockUser.upsert).toHaveBeenCalledWith({
      where: { email: "new@example.com" },
      update: {},
      create: { email: "new@example.com" },
    });
    expect(mockOrganizationMember.create).toHaveBeenCalledWith({
      data: { organizationId: "org-1", userId: "user-2", role: "MEMBER" },
    });
    expect(mockWorkspaceMember.create).toHaveBeenCalledWith({
      data: { workspaceId: "ws-1", userId: "user-2", role: "MEMBER" },
    });
  });

  it("does not create a duplicate org member when the user is already in the org", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ id: "org-member-existing" });

    await addWorkspaceMember("org", "ws", { email: "existing@example.com", role: "ADMIN" });

    expect(mockOrganizationMember.create).not.toHaveBeenCalled();
    expect(mockWorkspaceMember.create).toHaveBeenCalledWith({
      data: { workspaceId: "ws-1", userId: "user-2", role: "ADMIN" },
    });
  });

  it("throws when the user is already a workspace member", async () => {
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-existing" });

    await expect(
      addWorkspaceMember("org", "ws", { email: "existing@example.com", role: "MEMBER" })
    ).rejects.toThrow("User is already a member of this workspace");
    expect(mockWorkspaceMember.create).not.toHaveBeenCalled();
  });

  it("rejects a workspace MEMBER", async () => {
    mockCallerRoles("MEMBER");

    await expect(
      addWorkspaceMember("org", "ws", { email: "new@example.com", role: "ADMIN" })
    ).rejects.toThrow("Forbidden: workspace admin required");
    expect(mockWorkspaceMember.create).not.toHaveBeenCalled();
    expect(mockUser.upsert).not.toHaveBeenCalled();
  });

  it("allows an org OWNER who is only a workspace MEMBER", async () => {
    mockCallerRoles("MEMBER", "OWNER");
    mockUser.upsert.mockResolvedValue({ id: "user-2", email: "new@example.com" });

    await addWorkspaceMember("org", "ws", { email: "new@example.com", role: "MEMBER" });

    expect(mockWorkspaceMember.create).toHaveBeenCalled();
  });

  it("normalizes an out-of-domain role before writing it", async () => {
    mockUser.upsert.mockResolvedValue({ id: "user-2", email: "new@example.com" });

    await addWorkspaceMember("org", "ws", {
      email: "new@example.com",
      // Server actions receive untrusted input at runtime, whatever the type says.
      role: "OWNER" as unknown as "ADMIN",
    });

    expect(mockWorkspaceMember.create).toHaveBeenCalledWith({
      data: { workspaceId: "ws-1", userId: "user-2", role: "ADMIN" },
    });
  });

  it("rejects an invalid email", async () => {
    await expect(
      addWorkspaceMember("org", "ws", { email: "not-an-email", role: "MEMBER" })
    ).rejects.toThrow("A valid email address is required");
    expect(mockUser.upsert).not.toHaveBeenCalled();
  });

  it("rejects an empty email", async () => {
    await expect(
      addWorkspaceMember("org", "ws", { email: "   ", role: "MEMBER" })
    ).rejects.toThrow("A valid email address is required");
    expect(mockUser.upsert).not.toHaveBeenCalled();
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      addWorkspaceMember("org", "ws", { email: "new@example.com", role: "MEMBER" })
    ).rejects.toThrow("Unauthorized");
    expect(mockUser.upsert).not.toHaveBeenCalled();
  });
});

// ─── updateWorkspaceMemberRole ─────────────────────────────────────────────────

describe("updateWorkspaceMemberRole", () => {
  it("updates the member's role", async () => {
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "MEMBER" });

    await updateWorkspaceMemberRole("org", "ws", "ws-member-1", "ADMIN");

    expect(mockWorkspaceMember.update).toHaveBeenCalledWith({
      where: { id: "ws-member-1" },
      data: { role: "ADMIN" },
    });
  });

  it("throws Member not found when the member does not belong to this workspace", async () => {
    mockWorkspaceMember.findFirst.mockResolvedValue(null);

    await expect(
      updateWorkspaceMemberRole("org", "ws", "ws-member-other", "ADMIN")
    ).rejects.toThrow("Member not found");
    expect(mockWorkspaceMember.update).not.toHaveBeenCalled();
  });

  it("blocks demoting the last remaining admin", async () => {
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "ADMIN" });
    mockWorkspaceMember.findMany.mockResolvedValue([{ role: "ADMIN" }, { role: "MEMBER" }]);

    await expect(
      updateWorkspaceMemberRole("org", "ws", "ws-member-1", "MEMBER")
    ).rejects.toThrow("Cannot demote the last remaining admin");
    expect(mockWorkspaceMember.update).not.toHaveBeenCalled();
  });

  it("allows demoting an admin when another admin remains", async () => {
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "ADMIN" });
    mockWorkspaceMember.findMany.mockResolvedValue([{ role: "ADMIN" }, { role: "ADMIN" }]);

    await updateWorkspaceMemberRole("org", "ws", "ws-member-1", "MEMBER");

    expect(mockWorkspaceMember.update).toHaveBeenCalledWith({
      where: { id: "ws-member-1" },
      data: { role: "MEMBER" },
    });
  });

  it("counts a legacy OWNER row as an admin when guarding the last admin", async () => {
    // An exact SQL match on "ADMIN" would not see the OWNER row, would tally
    // one admin instead of two, and would wrongly block this demotion.
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "ADMIN" });
    mockWorkspaceMember.findMany.mockResolvedValue([{ role: "ADMIN" }, { role: "OWNER" }]);

    await updateWorkspaceMemberRole("org", "ws", "ws-member-1", "MEMBER");

    expect(mockWorkspaceMember.update).toHaveBeenCalled();
  });

  it("treats the member being demoted as an admin even when stored as OWNER", async () => {
    // The inverse: the guard must fire for a legacy OWNER row too.
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "OWNER" });
    mockWorkspaceMember.findMany.mockResolvedValue([{ role: "OWNER" }, { role: "MEMBER" }]);

    await expect(
      updateWorkspaceMemberRole("org", "ws", "ws-member-1", "MEMBER")
    ).rejects.toThrow("Cannot demote the last remaining admin");
    expect(mockWorkspaceMember.update).not.toHaveBeenCalled();
  });

  it("rejects a workspace MEMBER", async () => {
    // Before this gate any member could promote themselves to ADMIN.
    mockCallerRoles("MEMBER");
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "MEMBER" });

    await expect(
      updateWorkspaceMemberRole("org", "ws", "ws-member-1", "ADMIN")
    ).rejects.toThrow("Forbidden: workspace admin required");
    expect(mockWorkspaceMember.update).not.toHaveBeenCalled();
  });

  it("allows an org OWNER who is only a workspace MEMBER", async () => {
    mockCallerRoles("MEMBER", "OWNER");
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "MEMBER" });

    await updateWorkspaceMemberRole("org", "ws", "ws-member-1", "ADMIN");

    expect(mockWorkspaceMember.update).toHaveBeenCalled();
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      updateWorkspaceMemberRole("org", "ws", "ws-member-1", "ADMIN")
    ).rejects.toThrow("Unauthorized");
  });
});

// ─── removeWorkspaceMember ──────────────────────────────────────────────────────

describe("removeWorkspaceMember", () => {
  // count() now only answers the total-members question. The admin tally is
  // computed in application code from findMany(), so that a legacy "OWNER" row
  // is counted as the administrator it actually is.
  function mockCounts(total: number, roles: string[] = ["ADMIN", "ADMIN"]) {
    mockWorkspaceMember.count.mockResolvedValue(total);
    mockWorkspaceMember.findMany.mockResolvedValue(roles.map((role) => ({ role })));
  }

  it("removes the member", async () => {
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "MEMBER" });
    mockCounts(2, ["ADMIN", "MEMBER"]);

    await removeWorkspaceMember("org", "ws", "ws-member-1");

    expect(mockWorkspaceMember.delete).toHaveBeenCalledWith({ where: { id: "ws-member-1" } });
    expect(mockWorkspaceMember.updateMany).toHaveBeenCalledWith({ where: { id: "ws-member-1", role: "MEMBER" }, data: { role: "MEMBER" } });
    expect(mockWorkspaceMember.updateMany.mock.invocationCallOrder[0]).toBeLessThan(mockPrisma.agent.findMany.mock.invocationCallOrder[0]);
    expect(mockPrisma.agent.findMany.mock.invocationCallOrder[0]).toBeLessThan(mockWorkspaceMember.delete.mock.invocationCallOrder[0]);
  });

  it("does not overwrite a concurrent role change when locking a departing member", async () => {
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "MEMBER" });
    mockCounts(2, ["ADMIN", "MEMBER"]);
    mockWorkspaceMember.updateMany.mockResolvedValue({ count: 0 });
    await expect(removeWorkspaceMember("org", "ws", "ws-member-1")).rejects.toThrow("Membership changed");
    expect(mockWorkspaceMember.delete).not.toHaveBeenCalled();
  });

  it("throws Member not found when the member does not belong to this workspace", async () => {
    mockWorkspaceMember.findFirst.mockResolvedValue(null);

    await expect(removeWorkspaceMember("org", "ws", "ws-member-other")).rejects.toThrow(
      "Member not found"
    );
    expect(mockWorkspaceMember.delete).not.toHaveBeenCalled();
  });

  it("blocks removing the last member of a workspace", async () => {
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "MEMBER" });
    mockCounts(1, ["MEMBER"]);

    await expect(removeWorkspaceMember("org", "ws", "ws-member-1")).rejects.toThrow(
      "Cannot remove the last member of a workspace"
    );
    expect(mockWorkspaceMember.delete).not.toHaveBeenCalled();
  });

  it("blocks removing the last remaining admin", async () => {
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "ADMIN" });
    mockCounts(2, ["ADMIN", "MEMBER"]);

    await expect(removeWorkspaceMember("org", "ws", "ws-member-1")).rejects.toThrow(
      "Cannot remove the last remaining admin"
    );
    expect(mockWorkspaceMember.delete).not.toHaveBeenCalled();
  });

  it("allows removing an admin when another admin remains", async () => {
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "ADMIN" });
    mockCounts(3, ["ADMIN", "ADMIN", "MEMBER"]);

    await removeWorkspaceMember("org", "ws", "ws-member-1");

    expect(mockWorkspaceMember.delete).toHaveBeenCalledWith({ where: { id: "ws-member-1" } });
  });

  it("counts a legacy OWNER row as an admin when guarding the last admin", async () => {
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "ADMIN" });
    mockCounts(3, ["ADMIN", "OWNER", "MEMBER"]);

    await removeWorkspaceMember("org", "ws", "ws-member-1");

    expect(mockWorkspaceMember.delete).toHaveBeenCalled();
  });

  it("rejects a workspace MEMBER", async () => {
    mockCallerRoles("MEMBER");
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "MEMBER" });
    mockCounts(3, ["ADMIN", "ADMIN"]);

    await expect(removeWorkspaceMember("org", "ws", "ws-member-1")).rejects.toThrow(
      "Forbidden: workspace admin required"
    );
    expect(mockWorkspaceMember.delete).not.toHaveBeenCalled();
  });

  it("allows an org OWNER who is only a workspace MEMBER", async () => {
    mockCallerRoles("MEMBER", "OWNER");
    mockWorkspaceMember.findFirst.mockResolvedValue({ id: "ws-member-1", role: "MEMBER" });
    mockCounts(3, ["ADMIN", "ADMIN"]);

    await removeWorkspaceMember("org", "ws", "ws-member-1");

    expect(mockWorkspaceMember.delete).toHaveBeenCalled();
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(removeWorkspaceMember("org", "ws", "ws-member-1")).rejects.toThrow(
      "Unauthorized"
    );
  });
});

// ─── setActiveScoringModel ──────────────────────────────────────────────────────
// Gated by resolveWorkspaceAdmin (lib/permissions.ts), not the local
// resolveWorkspace() helper — the workspace.findFirst() shape it queries
// includes the caller's own membership role.

describe("setActiveScoringModel", () => {
  // The stored role is a bare VarChar with no DB enum, so the fixture has to be
  // able to express values outside WorkspaceRole -- that is exactly the bug
  // being guarded against here. orgRole covers the separate rule that an org
  // OWNER/ADMIN is a workspace admin everywhere in their org.
  function mockAdminWorkspace(
    role: "OWNER" | "ADMIN" | "MEMBER" | "owner" = "ADMIN",
    orgRole: "OWNER" | "ADMIN" | "MEMBER" = "MEMBER"
  ) {
    mockWorkspace.findFirst.mockResolvedValue({
      id: "ws-1",
      organizationId: "org-1",
      members: [{ role }],
      organization: { members: [{ role: orgRole }] },
    });
  }

  it("upserts the workspace scoring config with the chosen model", async () => {
    mockAdminWorkspace();

    await setActiveScoringModel("org", "ws", "model-1");

    expect(mockWorkspaceScoringConfig.upsert).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      create: { workspaceId: "ws-1", scoringModelId: "model-1" },
      update: { scoringModelId: "model-1", updatedAt: expect.any(Date) },
    });
  });

  it("allows clearing the active model with null", async () => {
    mockAdminWorkspace();

    await setActiveScoringModel("org", "ws", null);

    expect(mockWorkspaceScoringConfig.upsert).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      create: { workspaceId: "ws-1", scoringModelId: null },
      update: { scoringModelId: null, updatedAt: expect.any(Date) },
    });
  });

  it("lets a member stored with the invalid OWNER workspace role set the model", async () => {
    // This is the reported failure. Workspaces created through the MCP
    // create_workspace tool stored their creator as "OWNER", which is an
    // OrgRole and not a WorkspaceRole, and setActiveScoringModel then threw
    // "Forbidden: workspace admin required" at the person who owned the org.
    mockAdminWorkspace("OWNER");

    await setActiveScoringModel("org", "ws", "model-1");

    expect(mockWorkspaceScoringConfig.upsert).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      create: { workspaceId: "ws-1", scoringModelId: "model-1" },
      update: { scoringModelId: "model-1", updatedAt: expect.any(Date) },
    });
  });

  it("lets a member stored with a lowercase owner workspace role set the model", async () => {
    mockAdminWorkspace("owner");

    await setActiveScoringModel("org", "ws", "model-1");

    expect(mockWorkspaceScoringConfig.upsert).toHaveBeenCalled();
  });

  it("lets an org OWNER who is only a workspace MEMBER set the model", async () => {
    mockAdminWorkspace("MEMBER", "OWNER");

    await setActiveScoringModel("org", "ws", "model-1");

    expect(mockWorkspaceScoringConfig.upsert).toHaveBeenCalled();
  });

  // Permission outcomes are returned as values, not thrown: a thrown Server
  // Action error loses its message to Next's production mask before the client
  // can read it. See app/[orgSlug]/settings/actions.ts.
  it("returns a clean error when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(setActiveScoringModel("org", "ws", "model-1")).resolves.toEqual({
      ok: false,
      error: "You are not signed in.",
    });
    expect(mockWorkspaceScoringConfig.upsert).not.toHaveBeenCalled();
  });

  it("returns Workspace not found when caller is not a member", async () => {
    mockWorkspace.findFirst.mockResolvedValue(null);
    await expect(setActiveScoringModel("org", "ws", "model-1")).resolves.toEqual({
      ok: false,
      error: "Workspace not found",
    });
  });

  it("returns Forbidden when caller is a workspace MEMBER, not admin", async () => {
    mockAdminWorkspace("MEMBER");
    await expect(setActiveScoringModel("org", "ws", "model-1")).resolves.toEqual({
      ok: false,
      error: "Forbidden: workspace admin required",
    });
    expect(mockWorkspaceScoringConfig.upsert).not.toHaveBeenCalled();
  });
});
