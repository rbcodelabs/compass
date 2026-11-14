/**
 * Workspace export/import: classification of every Prisma model.
 *
 * Buckets (see the ADR "Workspace export and import (portable bundle)" in
 * Compass Docs → Architecture Decisions):
 *   CONTENT      – workspace content, exported and imported (core tier).
 *   TIERED       – workspace content that is optional; NOT in the v1 core tier.
 *   SECRET       – credentials, tokens, sessions. Never exported.
 *   REFERENCE    – org / user / global rows. Referenced by id, remapped on
 *                  import, never exported.
 *   EPHEMERAL    – runtime, derived, audit or queue data. Not exported;
 *                  regenerated or reset in the new workspace.
 *
 * Every model in prisma/schema.prisma MUST appear here; the contract test in
 * __tests__/workspace-export-model-registry.test.ts fails on an unclassified
 * (or stale) entry so new models force an explicit export decision.
 */

export type ExportBucket = "CONTENT" | "TIERED" | "SECRET" | "REFERENCE" | "EPHEMERAL";

const list = (bucket: ExportBucket, names: string): Array<[string, ExportBucket]> =>
  names
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => [name, bucket]);

export const MODEL_BUCKETS: Readonly<Record<string, ExportBucket>> = Object.fromEntries([
  ...list(
    "CONTENT",
    `Workspace WorkspaceSequence WorkspaceModule PortalHomeLayout SavedView WorkspaceScoringConfig
     AnalyticsConnection Squad SharedFieldOptionSet CustomFieldDefinition CustomFieldValue
     CanvasNodePosition ChecklistTemplate ChecklistTemplateItem OKRCycle Objective KeyResult CheckIn
     Opportunity OpportunityScore Solution SolutionScore SolutionComment Assumption Experiment
     ExperimentResult Evidence EvidenceResearchSource RoadmapItem RoadmapVote LaunchChecklist
     LaunchChecklistItem Task EntityLink
     Comment DocCommentAnchor SolutionPlanProposal CommentElementAnchor
     CommentExternalAuthor Doc DocComment DocVersion Artifact ArtifactRevision FeedbackItem
     FeedbackSource FeedbackElementAnchor FeedbackAttachment FeedbackVote ResearchStudy
     ResearchSession ResearchTurn ResearchAttachment ResearchSynthesis PMInterview ReviewRequest
     ReviewRevision ReviewOption DecisionRecord DecisionApplication DecisionEvidenceRef
     CardSortRound CardSortProposal CardSortNewEntry MetricDefinition MetricRevision MetricBinding
     MetricObservation Agent WorkspaceDefaultAgent CapabilityPack CapabilityPackVersion
     WorkspaceCapabilityPack Follow`
  ),
  ...list(
    "TIERED",
    `AgentConversation AgentConversationParticipant AgentMessage PortfolioCapacityPlan
     PortfolioCapacityReservation ReleaseRun ReleaseRunTask`
  ),
  ...list(
    "SECRET",
    `Account Session VerificationToken Authenticator PortalSession PortalVerificationToken
     PreviewAutomationSession PreviewAutomationNonce ApiKey OAuthClient OAuthAuthorizationCode
     OAuthToken OAuthConsent OAuthAuthorizationEvent McpConnector McpConnectorGrant
     McpConnectorAuthRequest FeedbackSourceToken EmbedVisitorSession EmbedAuthHandoff
     ResearchParticipantToken ResearchVoiceCall ArtifactShare ArtifactShareSession
     ArtifactShareCommenter`
  ),
  ...list(
    "REFERENCE",
    `User Organization OrganizationMember WorkspaceMember ScoringModel ScoringModelMetric
     PortalAccount AgentWorkspaceGrant UserDefaultAgent AgentOrgAdminGrant`
  ),
  ...list(
    "EPHEMERAL",
    `WorkspaceUpdateEvent WorkspaceUpdatesState WorkspaceUpdatesReadState UiSession UiCommand
     Notification PreviewAutomationRun ResearchRequest ResearchBlobCleanup ArtifactBlobCleanup
     DocOperation DocStorageObject ResearchParticipantVoiceEvent ResearchVoiceEvent
     ResearchVoiceCommand AgentRuntimeConfig AgentRuntimeSnapshot AgentRun AgentRunEvent AgentSession
     AgentWebSearch AgentToolCall AgentAuditLog AgentConversationReview NowGateEvaluation
     NowPolicyApplicationEvidence PortfolioCapacityOperation ReleaseDispatch WorkspaceActivationState
     ArtifactShareEvent`
  ),
]);

/**
 * Columns that carry secrets on otherwise-exported models. The exporter nulls
 * these; the importer additionally applies IMPORT_OVERRIDES.
 */
export const SECRET_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  Workspace: [
    "ssoSecretEncrypted",
    "ssoSecretUpdatedAt",
    "anthropicApiKeyEncrypted",
    "anthropicApiKeyLast4",
  ],
  AnalyticsConnection: ["secretEncrypted"],
  ResearchStudy: ["shareTokenHash"],
  ResearchSession: ["resumeTokenHash", "participantTokenId", "activeRequestId", "voiceLeaseId"],
  CommentExternalAuthor: ["embedTokenId"],
};

/** Values forced on import for models whose secrets were stripped. */
export const IMPORT_OVERRIDES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  Workspace: { ssoEnabled: false },
  AnalyticsConnection: { enabled: false },
};

export function modelsInBucket(...buckets: ExportBucket[]): string[] {
  return Object.entries(MODEL_BUCKETS)
    .filter(([, b]) => buckets.includes(b))
    .map(([name]) => name);
}
