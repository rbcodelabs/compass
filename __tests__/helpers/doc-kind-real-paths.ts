import type { DocKind } from "@/lib/doc-kinds"

/**
 * The 49 real doc paths of the rbcodelabs/compass workspace (parent/title), each with the expected kind worked out BY HAND from the
 * classifier rules, not by running the function:
 *
 *   ADR         title starts with "ADR" (word boundary, any case), or with four digits then a space . : or - (but not an ISO date
 *               prefix such as 2026-11-07, which would otherwise swallow the dated note "2026-11-07 Agent chat run-status cleanup")
 *   QA_REPORT   title starts with "QA Report", or the parent page is "QA Reports"
 *   DESIGN      the parent page is "Design" or "Designs", or the title starts with "Design:" or "Design_"
 *   null        everything else (left unset)
 * First match wins. Shared by the classifier unit test and the 118 migration integration test.
 */
export type RealDocRow = { path: string; parent: string | null; title: string; expected: DocKind | null }

const ADR_PARENT = "Architecture Decisions"
export const REAL_DOC_ROWS: RealDocRow[] = [
  // Architecture Decisions container and its children
  { path: "Architecture Decisions", parent: null, title: "Architecture Decisions", expected: null },
  { path: "Architecture Decisions/ADR - One generic entity_links table for association links", parent: ADR_PARENT, title: "ADR - One generic entity_links table for association links", expected: "ADR" },
  { path: "Architecture Decisions/ADR - Human-readable work item IDs (per-workspace, per-type counters)", parent: ADR_PARENT, title: "ADR - Human-readable work item IDs (per-workspace, per-type counters)", expected: "ADR" },
  { path: "Architecture Decisions/Sheets-like DataGrid editing and batch create", parent: ADR_PARENT, title: "Sheets-like DataGrid editing and batch create", expected: null },
  { path: "Architecture Decisions/ADR - opencode as an alternative agent harness", parent: ADR_PARENT, title: "ADR - opencode as an alternative agent harness", expected: "ADR" },
  { path: "Architecture Decisions/ADR - Spec and Discovery Plan documents (markdown with embedded record tags)", parent: ADR_PARENT, title: "ADR - Spec and Discovery Plan documents (markdown with embedded record tags)", expected: "ADR" },
  { path: "Architecture Decisions/ADR - Doc comment @-mentions create assigned tasks", parent: ADR_PARENT, title: "ADR - Doc comment @-mentions create assigned tasks", expected: "ADR" },
  { path: "Architecture Decisions/ADR - Cross-workspace typed links", parent: ADR_PARENT, title: "ADR - Cross-workspace typed links", expected: "ADR" },
  { path: "Architecture Decisions/Unify Updates and Notifications on a shared event spine", parent: ADR_PARENT, title: "Unify Updates and Notifications on a shared event spine", expected: null },
  { path: "Architecture Decisions/ADR - Feedback Addressor Agent", parent: ADR_PARENT, title: "ADR - Feedback Addressor Agent", expected: "ADR" },
  { path: "Architecture Decisions/Cloud agents as first-class, assignable identities", parent: ADR_PARENT, title: "Cloud agents as first-class, assignable identities", expected: null },
  { path: "Architecture Decisions/ADR-0020 Agent shell and GitHub access (reverses ADR 0019 Bash exclusion)", parent: ADR_PARENT, title: "ADR-0020 Agent shell and GitHub access (reverses ADR 0019 Bash exclusion)", expected: "ADR" },
  { path: "Architecture Decisions/ADR - Workspace export and import (portable bundle)", parent: ADR_PARENT, title: "ADR - Workspace export and import (portable bundle)", expected: "ADR" },
  { path: "Architecture Decisions/ADR - Agents may request release authorization", parent: ADR_PARENT, title: "ADR - Agents may request release authorization", expected: "ADR" },
  { path: "Architecture Decisions/ADR - Personal agents use their owner's connected accounts", parent: ADR_PARENT, title: "ADR - Personal agents use their owner's connected accounts", expected: "ADR" },
  { path: "Architecture Decisions/Pinned columns for board views", parent: ADR_PARENT, title: "Pinned columns for board views", expected: null },
  { path: "Architecture Decisions/ADR - Custom field inheritance rules", parent: ADR_PARENT, title: "ADR - Custom field inheritance rules", expected: "ADR" },
  { path: "Architecture Decisions/ADR-0021 Federated docs sources for support portals", parent: ADR_PARENT, title: "ADR-0021 Federated docs sources for support portals", expected: "ADR" },
  { path: "Architecture Decisions/ADR - Workspace-scoped ArtifactTemplate for artifacts and agent sandboxes", parent: ADR_PARENT, title: "ADR - Workspace-scoped ArtifactTemplate for artifacts and agent sandboxes", expected: "ADR" },
  { path: "Architecture Decisions/0018 Fold Spec docs into Doc kind and a general doc-to-Loop link", parent: ADR_PARENT, title: "0018 Fold Spec docs into Doc kind and a general doc-to-Loop link", expected: "ADR" },
  // Loose roots and the Decisions / Architecture containers
  { path: "Next steps", parent: null, title: "Next steps", expected: null },
  { path: "Decisions", parent: null, title: "Decisions", expected: null },
  { path: "Decisions/ADR - Compass as a Geode Sync Provider", parent: "Decisions", title: "ADR - Compass as a Geode Sync Provider", expected: "ADR" },
  { path: "Spec - B · Spec document_ long-form spec with live embedded cards and a traceability rail (sample)", parent: null, title: "Spec - B · Spec document_ long-form spec with live embedded cards and a traceability rail (sample)", expected: null },
  { path: "Discovery Plan - Discovery work is scattered across pages, so teams can't see or present the outcome-to-solution story in one place", parent: null, title: "Discovery Plan - Discovery work is scattered across pages, so teams can't see or present the outcome-to-solution story in one place", expected: null },
  { path: "Architecture", parent: null, title: "Architecture", expected: null },
  { path: "Architecture/ADR-0018 Tracked Entities", parent: "Architecture", title: "ADR-0018 Tracked Entities", expected: "ADR" },
  // QA Reports
  { path: "QA Reports", parent: null, title: "QA Reports", expected: null },
  { path: "QA Reports/QA Report — Nav cleanup PR 473 — 2026-10-22 09_13", parent: "QA Reports", title: "QA Report — Nav cleanup PR 473 — 2026-10-22 09_13", expected: "QA_REPORT" },
  { path: "QA Reports/QA Report - Workspace export and import - 2026-11-06 14_30", parent: "QA Reports", title: "QA Report - Workspace export and import - 2026-11-06 14_30", expected: "QA_REPORT" },
  { path: "QA Reports/QA Report — Pinned columns for board views (PR #514) — 2026-11-07", parent: "QA Reports", title: "QA Report — Pinned columns for board views (PR #514) — 2026-11-07", expected: "QA_REPORT" },
  { path: "QA Reports/QA Report — Linked opportunities in objective detail (PR 526) — 2026-11-07", parent: "QA Reports", title: "QA Report — Linked opportunities in objective detail (PR 526) — 2026-11-07", expected: "QA_REPORT" },
  { path: "QA Reports/QA Report - Roadmap Gallery view - 2026-11-08 0715", parent: "QA Reports", title: "QA Report - Roadmap Gallery view - 2026-11-08 0715", expected: "QA_REPORT" },
  { path: "QA Reports/Active card state on boards (TASK-138) - 2026-11-08", parent: "QA Reports", title: "Active card state on boards (TASK-138) - 2026-11-08", expected: "QA_REPORT" },
  { path: "QA Reports/QA Report — Artifacts can link to Experiments — 2026-11-09", parent: "QA Reports", title: "QA Report — Artifacts can link to Experiments — 2026-11-09", expected: "QA_REPORT" },
  { path: "QA Reports/QA Report - Experiments Gallery view - 2026-11-09 0845", parent: "QA Reports", title: "QA Report - Experiments Gallery view - 2026-11-09 0845", expected: "QA_REPORT" },
  // Security, QA (not QA Reports)
  { path: "Security", parent: null, title: "Security", expected: null },
  { path: "Security/Security Review — Code Findings 2026-10-22", parent: "Security", title: "Security Review — Code Findings 2026-10-22", expected: null },
  { path: "QA", parent: null, title: "QA", expected: null },
  { path: "QA/2026-11-07 Agent chat run-status cleanup", parent: "QA", title: "2026-11-07 Agent chat run-status cleanup", expected: null },
  // Product / Designs and Design
  { path: "Product", parent: null, title: "Product", expected: null },
  { path: "Product/Designs", parent: "Product", title: "Designs", expected: null },
  { path: "Product/Designs/Federated docs sources for support portals", parent: "Designs", title: "Federated docs sources for support portals", expected: "DESIGN" },
  { path: "Design", parent: null, title: "Design", expected: null },
  { path: "Design/Design_ agent-managed workspace GitHub repos", parent: "Design", title: "Design_ agent-managed workspace GitHub repos", expected: "DESIGN" },
  { path: "Design/A1 spike findings_ TOOL_APPROVAL on the existing decision tables", parent: "Design", title: "A1 spike findings_ TOOL_APPROVAL on the existing decision tables", expected: "DESIGN" },
  // Spec docs at the root and under Specs
  { path: "Spec - Template-based first-time workspace setup", parent: null, title: "Spec - Template-based first-time workspace setup", expected: null },
  { path: "Specs", parent: null, title: "Specs", expected: null },
  { path: "Specs/Artifact templates v1", parent: "Specs", title: "Artifact templates v1", expected: null },
]

// Hand-counted from the table above: 17 ADR, 8 QA_REPORT, 3 DESIGN, 21 left unset, 49 in all.
export const EXPECTED_COUNTS = { ADR: 17, QA_REPORT: 8, DESIGN: 3, unset: 21, total: 49 }
