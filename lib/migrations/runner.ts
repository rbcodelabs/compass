import { NextResponse } from "next/server";
import { Pool, PoolClient } from "pg";
import { readFileSync } from "fs";
import path from "path";
import { createHash, randomUUID } from "node:crypto";
import { backfillRoadmapCommitmentProvenance } from "@/lib/dsql-backfill";
import { inspectVoiceMigrationCatalog, voiceMigrationCatalog } from "@/lib/research-voice-migration";
import {
  applyLegacyDecisionReviewRepair,
  getLegacyDecisionReviewRepairStatus,
  LEGACY_DECISION_REVIEW_REPAIR_MIGRATION,
} from "@/lib/migrations/legacy-decision-review-repair";
import type { LegacyDecisionRepairManifest } from "@/lib/legacy-decision-repair";
import { assertAgentIdentityMigration } from "@/lib/migrations/agent-identity";
import { assertSharedFieldOptionSetsMigration } from "@/lib/migrations/shared-field-option-sets";
import { assertOAuthAuthorizationServerMigration } from "@/lib/migrations/oauth-authorization-server";



const MIGRATIONS = [
  {
    name: "001_init",
    filePath: path.join(process.cwd(), "prisma/migrations/001_init/migration.sql"),
  },
  {
    name: "002_custom_fields",
    filePath: path.join(process.cwd(), "prisma/migrations/002_custom_fields/migration.sql"),
  },
  {
    name: "003_fix_custom_field_tables",
    filePath: path.join(process.cwd(), "prisma/migrations/003_fix_custom_field_tables/migration.sql"),
  },
  {
    name: "004_squads",
    filePath: path.join(process.cwd(), "prisma/migrations/004_squads/migration.sql"),
  },
  {
    name: "005_cross_links",
    filePath: path.join(process.cwd(), "prisma/migrations/005_cross_links/migration.sql"),
  },
  {
    name: "006_api_keys",
    filePath: path.join(process.cwd(), "prisma/migrations/006_api_keys/migration.sql"),
  },
  {
    name: "007_sort_order",
    filePath: path.join(process.cwd(), "prisma/migrations/007_sort_order/migration.sql"),
  },
  {
    name: "008_roadmap_experiment_link",
    filePath: path.join(process.cwd(), "prisma/migrations/008_roadmap_experiment_link/migration.sql"),
  },
  {
    name: "009_feedback_voting",
    filePath: path.join(process.cwd(), "prisma/migrations/009_feedback_voting/migration.sql"),
  },
  {
    name: "010_feedback_indexes",
    filePath: path.join(process.cwd(), "prisma/migrations/010_feedback_indexes/migration.sql"),
  },
  {
    name: "011_docs",
    filePath: path.join(process.cwd(), "prisma/migrations/011_docs/migration.sql"),
  },
  {
    name: "012_doc_metadata",
    filePath: path.join(process.cwd(), "prisma/migrations/012_doc_metadata/migration.sql"),
  },
  {
    name: "013_portal_auth",
    filePath: path.join(process.cwd(), "prisma/migrations/013_portal_auth/migration.sql"),
  },
  {
    name: "014_feedback_type",
    filePath: path.join(process.cwd(), "prisma/migrations/014_feedback_type/migration.sql"),
  },
  {
    name: "015_roadmap_dates",
    filePath: path.join(process.cwd(), "prisma/migrations/015_roadmap_dates/migration.sql"),
  },
  {
    name: "016_audit_fields_source_tracking",
    filePath: path.join(process.cwd(), "prisma/migrations/016_audit_fields_source_tracking/migration.sql"),
  },
  {
    name: "017_evidence_graph",
    filePath: path.join(process.cwd(), "prisma/migrations/017_evidence_graph/migration.sql"),
  },
  {
    name: "018_workspace_branding",
    filePath: path.join(process.cwd(), "prisma/migrations/018_workspace_branding/migration.sql"),
  },
  {
    name: "019_scoring_models",
    filePath: path.join(process.cwd(), "prisma/migrations/019_scoring_models/migration.sql"),
  },
  {
    name: "020_portal_sso",
    filePath: path.join(process.cwd(), "prisma/migrations/020_portal_sso/migration.sql"),
  },
  {
    name: "021_feedback_attachments",
    filePath: path.join(process.cwd(), "prisma/migrations/021_feedback_attachments/migration.sql"),
  },
  {
    name: "022_solution_comments",
    filePath: path.join(process.cwd(), "prisma/migrations/022_solution_comments/migration.sql"),
  },
  {
    name: "023_solution_comment_plan_status",
    filePath: path.join(process.cwd(), "prisma/migrations/023_solution_comment_plan_status/migration.sql"),
  },
  {
    name: "024_canvas_node_positions",
    filePath: path.join(process.cwd(), "prisma/migrations/024_canvas_node_positions/migration.sql"),
  },
  {
    // Numbered "024" on main too — both branches independently picked the
    // next sequential number off of 023 before either merged. Different
    // migration names (tracked by full string, not numeric prefix), so no
    // functional collision — just cosmetic. Not renumbering
    // 024_canvas_node_positions since it's already applied against this
    // PR's preview deployment; renaming it would make the migrate endpoint
    // treat already-applied DDL as new.
    name: "024_launch_tiers_checklists",
    filePath: path.join(process.cwd(), "prisma/migrations/024_launch_tiers_checklists/migration.sql"),
  },
  {
    name: "025_doc_gtm_positioning_brief",
    filePath: path.join(process.cwd(), "prisma/migrations/025_doc_gtm_positioning_brief/migration.sql"),
  },
  {
    name: "026_roadmap_private_items",
    filePath: path.join(process.cwd(), "prisma/migrations/026_roadmap_private_items/migration.sql"),
  },
  {
    name: "027_tasks",
    filePath: path.join(process.cwd(), "prisma/migrations/027_tasks/migration.sql"),
  },
  {
    name: "028_agent_runtime_config",
    filePath: path.join(process.cwd(), "prisma/migrations/028_agent_runtime_config/migration.sql"),
  },
  {
    name: "029_agent_conversations",
    filePath: path.join(process.cwd(), "prisma/migrations/029_agent_conversations/migration.sql"),
  },
  {
    name: "030_agent_audit_log",
    filePath: path.join(process.cwd(), "prisma/migrations/030_agent_audit_log/migration.sql"),
  },
  {
    name: "031_doc_versions",
    filePath: path.join(process.cwd(), "prisma/migrations/031_doc_versions/migration.sql"),
  },
  {
    name: "032_doc_comments",
    filePath: path.join(process.cwd(), "prisma/migrations/032_doc_comments/migration.sql"),
  },
  {
    name: "033_feedback_grid_indexes",
    filePath: path.join(process.cwd(), "prisma/migrations/033_feedback_grid_indexes/migration.sql"),
  },
  {
    name: "034_artifacts",
    filePath: path.join(process.cwd(), "prisma/migrations/034_artifacts/migration.sql"),
  },
  {
    // Numbered "034" on this branch too -- same independently-picked-next-number
    // collision as 024 above. Different migration names (tracked by full
    // string, not numeric prefix), so no functional collision -- just
    // cosmetic. Not renumbering to keep parity with the migration folder
    // name already shipped in prisma/migrations/034_research_capture.
    name: "034_research_capture",
    filePath: path.join(process.cwd(), "prisma/migrations/034_research_capture/migration.sql"),
  },
  {
    name: "035_research_agent_scope",
    filePath: path.join(process.cwd(), "prisma/migrations/035_research_agent_scope/migration.sql"),
  },
  {
    name: "036_research_capture_hardening",
    filePath: path.join(process.cwd(), "prisma/migrations/036_research_capture_hardening/migration.sql"),
  },
  {
    name: "037_research_guided_ux",
    filePath: path.join(process.cwd(), "prisma/migrations/037_research_guided_ux/migration.sql"),
  },
  {
    name: "038_research_blob_cleanup",
    filePath: path.join(process.cwd(), "prisma/migrations/038_research_blob_cleanup/migration.sql"),
  },
  {
    name: "039_native_decision_gates",
    filePath: path.join(process.cwd(), "prisma/migrations/039_native_decision_gates/migration.sql"),
  },
  {
    name: "040_release_authorization",
    filePath: path.join(process.cwd(), "prisma/migrations/040_release_authorization/migration.sql"),
  },
  {
    name: "041_portfolio_capacity_ledger",
    filePath: path.join(process.cwd(), "prisma/migrations/041_portfolio_capacity_ledger/migration.sql"),
  },
  {
    name: "042_native_decision_gates_repair",
    filePath: path.join(process.cwd(), "prisma/migrations/042_native_decision_gates_repair/migration.sql"),
  },
  {
    name: "043_decision_evidence_refs",
    filePath: path.join(process.cwd(), "prisma/migrations/043_decision_evidence_refs/migration.sql"),
  },
  {
    name: "044_now_policy_application_evidence",
    filePath: path.join(process.cwd(), "prisma/migrations/044_now_policy_application_evidence/migration.sql"),
  },
  {
    name: "045_now_gate_shadow_evaluations",
    filePath: path.join(process.cwd(), "prisma/migrations/045_now_gate_shadow_evaluations/migration.sql"),
  },
  {
    name: "046_shared_comments",
    filePath: path.join(process.cwd(), "prisma/migrations/046_shared_comments/migration.sql"),
  },
  {
    name: "047_preview_automation",
    filePath: path.join(process.cwd(), "prisma/migrations/047_preview_automation/migration.sql"),
  },
  {
    // Migration receipts use full names, so independently chosen 047 prefixes coexist.
    name: "047_capability_packs",
    filePath: path.join(process.cwd(), "prisma/migrations/047_capability_packs/migration.sql"),
  },
  {
    name: "048_legacy_decision_review_repair",
    filePath: path.join(process.cwd(), "prisma/migrations/048_legacy_decision_review_repair/migration.sql"),
  },
  {
    name: "047_research_voice_control_plane",
    filePath: path.join(process.cwd(), "prisma/migrations/047_research_voice_control_plane/migration.sql"),
  },
  {
    name: "049_agent_identity",
    filePath: path.join(process.cwd(), "prisma/migrations/049_agent_identity/migration.sql"),
  },
  {
    name: "049_research_participant_voice",
    filePath: path.join(process.cwd(), "prisma/migrations/049_research_participant_voice/migration.sql"),
  },
  {
    name: "050_pm_interviews",
    filePath: path.join(process.cwd(), "prisma/migrations/050_pm_interviews/migration.sql"),
  },
  {
    name: "051_pm_agent_handoff",
    filePath: path.join(process.cwd(), "prisma/migrations/051_pm_agent_handoff/migration.sql"),
  },
  {
    name: "050_experiment_not_pursued",
    filePath: path.join(process.cwd(), "prisma/migrations/050_experiment_not_pursued/migration.sql"),
  },
  {
    name: "051_decision_task_bridge",
    filePath: path.join(process.cwd(), "prisma/migrations/051_decision_task_bridge/migration.sql"),
  },
  {
    name: "052_research_evidence_promotion",
    filePath: path.join(process.cwd(), "prisma/migrations/052_research_evidence_promotion/migration.sql"),
  },
  {
    // 053, not a second 052: ADR-0012 accepts the existing duplicate numbers but
    // directs that no further ones be added, and #234 took 052.
    name: "053_shared_field_option_sets",
    filePath: path.join(process.cwd(), "prisma/migrations/053_shared_field_option_sets/migration.sql"),
  },
  {
    // Multiple independent 054s/055s landed concurrently — accepted per the
    // same duplicate-number precedent noted above; the runner keys on exact
    // name, not number. Do NOT renumber any of these to "resolve" the
    // collision — some are already applied under their exact name in the
    // shared compass_preview schema, so renaming would orphan their receipt
    // and re-run the DDL.
    name: "054_research_study_artifact",
    filePath: path.join(process.cwd(), "prisma/migrations/054_research_study_artifact/migration.sql"),
  },
  {
    name: "054_workspace_wip_limits",
    filePath: path.join(process.cwd(), "prisma/migrations/054_workspace_wip_limits/migration.sql"),
  },
  {
    name: "054_webauthn_authenticators",
    filePath: path.join(process.cwd(), "prisma/migrations/054_webauthn_authenticators/migration.sql"),
  },
  {
    name: "055_workspace_launch_workflow_flag",
    filePath: path.join(process.cwd(), "prisma/migrations/055_workspace_launch_workflow_flag/migration.sql"),
  },
  {
    name: "055_oauth_authorization_server",
    filePath: path.join(process.cwd(), "prisma/migrations/055_oauth_authorization_server/migration.sql"),
  },
];

const DECISION_GATE_TABLES = ["review_requests", "review_revisions", "review_options", "decision_records", "decision_applications", "decision_evidence_refs", "now_policy_application_evidence", "now_gate_evaluations", "release_runs", "release_run_tasks", "release_dispatches", "portfolio_capacity_plans", "portfolio_capacity_reservations", "portfolio_capacity_operations"] as const;
const DECISION_GATE_COLUMNS = ["now_commitment_provenance", "now_decision_record_id"] as const;
const DECISION_GATE_INDEXES = ["idx_review_requests_workspace_state", "idx_review_revisions_request_id", "idx_review_options_revision_id", "idx_decision_records_workspace_decided", "idx_decision_records_request_id", "idx_decision_records_option_id", "idx_decision_applications_target", "idx_review_revisions_request_source", "idx_decision_evidence_refs_subject", "idx_now_policy_evidence_workspace_created", "idx_now_gate_evaluations_workspace_created", "idx_now_gate_evaluations_workspace_outcome_created", "idx_now_gate_evaluations_item_created", "idx_release_runs_workspace_state", "idx_release_runs_repository_pr", "idx_release_run_tasks_task_run", "idx_release_dispatches_claim", "idx_release_dispatches_run_status", "idx_capacity_plans_workspace_state", "idx_capacity_reservations_plan_state", "idx_capacity_reservations_item_history", "idx_capacity_reservations_decision", "idx_capacity_operations_plan_action_created"] as const;
const DECISION_GATE_CONSTRAINTS = ["review_requests_pkey", "idx_review_requests_subject_gate", "idx_review_requests_current_revision", "review_revisions_pkey", "idx_review_revisions_request_number", "idx_review_revisions_request_fingerprint", "review_options_pkey", "idx_review_options_revision_action", "decision_records_pkey", "idx_decision_records_revision", "idx_decision_records_idempotency", "decision_applications_pkey", "idx_decision_applications_receipt", "idx_decision_applications_decision_continuation", "decision_evidence_refs_pkey", "idx_decision_evidence_refs_revision_authority", "now_policy_application_evidence_pkey", "idx_now_policy_evidence_receipt", "now_gate_evaluations_pkey", "chk_now_gate_evaluations_mode", "chk_now_gate_evaluations_outcome", "chk_now_gate_evaluations_actor", "chk_roadmap_items_commitment_provenance_not_null", "release_runs_pkey", "idx_release_runs_scope_fingerprint", "idx_release_runs_authorization_decision", "release_run_tasks_pkey", "idx_release_run_tasks_run_task", "release_dispatches_pkey", "idx_release_dispatches_decision_continuation", "idx_release_dispatches_idempotency", "portfolio_capacity_plans_pkey", "idx_capacity_plans_workspace_policy", "idx_capacity_plans_active_workspace", "chk_capacity_plans_active_claim", "portfolio_capacity_reservations_pkey", "idx_capacity_reservations_plan_item", "idx_capacity_reservations_active_item", "chk_capacity_reservations_state_claim", "portfolio_capacity_operations_pkey", "idx_capacity_operations_workspace_key"] as const;
const DECISION_GATE_MIGRATIONS = ["039_native_decision_gates", "040_release_authorization", "041_portfolio_capacity_ledger", "042_native_decision_gates_repair", "043_decision_evidence_refs", "044_now_policy_application_evidence", "045_now_gate_shadow_evaluations"] as const;
const ASYNC_WAIT_MIGRATIONS = [...DECISION_GATE_MIGRATIONS, "047_research_voice_control_plane", "049_agent_identity", "049_research_participant_voice", "050_pm_interviews", "051_pm_agent_handoff", "052_research_evidence_promotion", "053_shared_field_option_sets", "055_oauth_authorization_server", "054_webauthn_authenticators"] as const;
/** ADR-0012 step 5. Unique first: the idempotency lookup promotion depends on. */
const RESEARCH_EVIDENCE_PROMOTION_INDEXES = ["idx_evidence_workspace_finding_key", "idx_evidence_research_sources_evidence_turn", "idx_evidence_research_synthesis", "idx_evidence_research_sources_turn"] as const;
const RESEARCH_VOICE_CONTROL_PLANE_INDEXES = [
  "idx_research_voice_calls_session_key",
  "idx_research_voice_calls_provider_call",
  "idx_research_voice_calls_worker_token",
  "idx_research_voice_calls_session_status",
  "idx_research_voice_calls_status_lease",
  "idx_research_voice_calls_status_heartbeat",
  "idx_research_voice_calls_participant_token",
  "idx_research_voice_commands_call_key",
  "idx_research_voice_commands_call_status_created",
  "idx_research_voice_commands_session",
  "idx_research_voice_events_call_provider",
  "idx_research_voice_events_call_ordinal",
  "idx_research_voice_events_call_item",
] as const;
const PM_INTERVIEW_INDEXES = ["idx_pm_interviews_study", "idx_pm_interviews_session", "idx_pm_interviews_workspace_created", "idx_pm_interviews_target", "idx_pm_interviews_generation_claim", "idx_pm_interviews_disposition_key"] as const;
type DecisionMigrationName = typeof DECISION_GATE_MIGRATIONS[number]
type DecisionMigrationStep = { id: string; sql?: string; kind: "sql" | "backfill"; async: boolean }
const isDecisionMigration = (name: string): name is DecisionMigrationName => DECISION_GATE_MIGRATIONS.includes(name as DecisionMigrationName)

function decisionMigrationPlan(migration: { name: string; filePath: string }) {
  const raw = readFileSync(migration.filePath, "utf8")
  const statements = raw.split("\n").map((line) => line.replace(/--.*$/, "").trimEnd()).join("\n")
    .split(/;\s*\n/).map((statement) => statement.trim()).filter(Boolean)
    .filter((statement) => !/^(?:BEGIN|COMMIT)$/i.test(statement))
    .map((statement) => statement.endsWith(";") ? statement : `${statement};`)
  const steps: DecisionMigrationStep[] = []
  for (const sql of statements) {
    steps.push({ id: `sql-${steps.length}`, kind: "sql", sql, async: /(?:CREATE\s+(?:UNIQUE\s+)?INDEX\s+ASYNC|ALTER\s+TABLE\s+ASYNC)/i.test(sql) })
    if ((migration.name === "039_native_decision_gates" || migration.name === "042_native_decision_gates_repair") && /ALTER\s+COLUMN\s+"?now_commitment_provenance"?\s+SET\s+DEFAULT/i.test(sql)) {
      steps.push({ id: `backfill-${steps.length}`, kind: "backfill", async: false })
    }
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ version: 1, name: migration.name, steps })).digest("hex")
  return { version: 1, fingerprint, steps }
}
function canonicalizeDsqlLiteralAny(value: string) {
  const literal = "'(?:''|[^'])*'"
  const literalList = `${literal}(?:\\s*,\\s*${literal})*`
  const pattern = new RegExp(`(^|[^\\w(])\\(*\\s*"?([a-z_][a-z0-9_]*)"?\\s*\\)*\\s*=\\s*ANY\\s*\\(\\s*\\(*\\s*ARRAY\\[(${literalList})\\]\\s*\\)*\\s*\\)`, "gi")
  return value.replace(pattern, (_match, prefix: string, identifier: string, values: string) => `${prefix}${identifier} in (${values})`)
}
const normalizeDefinition = (value: string) => value.toLowerCase().replace(/::(?:text|character varying)/g, "").replace(/["();]/g, "").replace(/\s+/g, " ").trim()
export const normalizeConstraintDefinition = (value: string, type: string) => {
  const typeSpecificDefinition = type === "p"
    ? value.replace(/\s+INCLUDE\s*\([^)]*\)\s*$/i, "")
    : type === "c"
      ? value.replace(/\s+NOT\s+VALID\s*$/i, "")
      : type === "u"
        ? value.replace(/^UNIQUE\s+NULLS\s+DISTINCT\b/i, "UNIQUE")
        : value
  return normalizeDefinition(type === "c"
    ? canonicalizeDsqlLiteralAny(typeSpecificDefinition.toLowerCase().replace(/::(?:text|character varying|varchar)(?:\[\])?/g, ""))
    : typeSpecificDefinition)
}
const normalizeIndexKeys = (value: string) => normalizeDefinition(value.match(/\(([^)]*)\)(?:\s+INCLUDE|\s+WHERE|\s*$)/i)?.[1] ?? value)
function splitTopLevel(value: string) {
  const parts: string[] = []; let depth = 0; let start = 0; let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === "'") quoted = !quoted
    else if (!quoted && char === "(") depth += 1
    else if (!quoted && char === ")") depth -= 1
    else if (!quoted && char === "," && depth === 0) { parts.push(value.slice(start, index).trim()); start = index + 1 }
  }
  parts.push(value.slice(start).trim()); return parts
}
const decisionGateSql = MIGRATIONS.filter((migration) => DECISION_GATE_MIGRATIONS.includes(migration.name as typeof DECISION_GATE_MIGRATIONS[number])).map((migration) => readFileSync(migration.filePath, "utf8")).join("\n")
type ColumnExpectation = { table: string; name: string; type: string; maxLength: number | null; datetimePrecision: number | null; nullable: boolean; default: string | null }
const COLUMN_EXPECTATIONS = new Map<string, ColumnExpectation>()
function normalizeColumnDefault(value: string | null | undefined) {
  if (!value) return null
  const normalized = value.replace(/::(?:text|character varying|character|smallint|integer|bigint|boolean)\b/gi, "").replace(/^\(([\s\S]*)\)$/, "$1").trim()
  const literal = normalized.match(/^'([^']*)'$/)
  if (literal) return literal[1]
  if (/^CURRENT_TIMESTAMP(?:\(\d+\))?$/i.test(normalized) || /^now\(\)$/i.test(normalized)) return "CURRENT_TIMESTAMP"
  if (/^[A-Z_]+$/.test(normalized)) return normalized
  return normalized.toLowerCase().replace(/\s+/g, "")
}
function sanitizeDefaultEvidence(value: string | null | undefined) {
  const normalized = normalizeColumnDefault(value)
  return normalized === null || /^(?:-?\d+|true|false|[A-Z_]+|CURRENT_TIMESTAMP|gen_random_uuid\(\))$/i.test(normalized)
    ? normalized
    : "REDACTED_EXPRESSION"
}
function addExpectedColumn(table: string, segment: string) {
  const match = segment.match(/^"([^"]+)"\s+(UUID|TEXT|INTEGER|BOOLEAN|VARCHAR\((\d+)\)|CHAR\((\d+)\)|TIMESTAMP\((\d+)\))([\s\S]*)$/i)
  if (!match) return
  const [, name, declaredType, varcharLength, charLength, precision, suffix] = match
  if (COLUMN_EXPECTATIONS.has(`${table}.${name}`)) return
  const type = /^VARCHAR/i.test(declaredType) ? "character varying" : /^CHAR/i.test(declaredType) ? "character" : /^TIMESTAMP/i.test(declaredType) ? "timestamp without time zone" : declaredType.toLowerCase()
  const defaultMatch = suffix.match(/\bDEFAULT\s+((?:'[^']*')|(?:-?\d+)|(?:[A-Za-z_][\w]*(?:\([^)]*\))?))/i)
  COLUMN_EXPECTATIONS.set(`${table}.${name}`, {
    table, name, type,
    maxLength: varcharLength ? Number(varcharLength) : charLength ? Number(charLength) : null,
    datetimePrecision: precision ? Number(precision) : null,
    nullable: !/\bNOT\s+NULL\b/i.test(suffix),
    default: normalizeColumnDefault(defaultMatch?.[1]),
  })
}
for (const match of decisionGateSql.matchAll(/CREATE TABLE IF NOT EXISTS "([^"]+)" \(([\s\S]*?)\n\);/g)) {
  for (const segment of splitTopLevel(match[2])) addExpectedColumn(match[1], segment)
}
for (const match of decisionGateSql.matchAll(/ALTER TABLE "([^"]+)" ADD COLUMN IF NOT EXISTS "([^"]+)"\s+([^;]+);/g)) {
  addExpectedColumn(match[1], `"${match[2]}" ${match[3]}`)
}
for (const match of decisionGateSql.matchAll(/ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" SET DEFAULT\s+([^;]+);/g)) {
  const key = `${match[1]}.${match[2]}`
  const expected = COLUMN_EXPECTATIONS.get(key)
  if (expected) COLUMN_EXPECTATIONS.set(key, { ...expected, default: normalizeColumnDefault(match[3]) })
}
const CONSTRAINT_EXPECTATIONS = new Map<string, { table: string; type: string; definition: string; keyColumns: string[] }>()
for (const match of decisionGateSql.matchAll(/CREATE TABLE IF NOT EXISTS "([^"]+)" \(([\s\S]*?)\n\);/g)) {
  for (const segment of splitTopLevel(match[2])) {
    const constraint = segment.match(/^CONSTRAINT "([^"]+)" ([\s\S]+)$/)
    if (!constraint) continue
    const normalized = normalizeDefinition(constraint[2])
    const type = normalized.startsWith("primary key") ? "p" : normalized.startsWith("unique") ? "u" : "c"
    const definition = normalizeConstraintDefinition(constraint[2], type)
    const keyColumns = type === "p" || type === "u"
      ? (constraint[2].match(/\(([^)]*)\)/)?.[1].match(/"([^"]+)"/g) ?? []).map((column) => column.slice(1, -1))
      : []
    CONSTRAINT_EXPECTATIONS.set(constraint[1], { table: match[1], type, definition, keyColumns })
  }
}
CONSTRAINT_EXPECTATIONS.set("chk_roadmap_items_commitment_provenance_not_null", {
  table: "roadmap_items",
  type: "c",
  definition: normalizeDefinition('CHECK ("now_commitment_provenance" IS NOT NULL)'),
  keyColumns: [],
})
const INDEX_EXPECTATIONS = new Map<string, { table: string; definition: string; keyColumns: string[]; unique: boolean }>()
for (const match of decisionGateSql.matchAll(/CREATE (UNIQUE )?INDEX ASYNC IF NOT EXISTS "([^"]+)" ON "([^"]+)" \(([^;]+)\);/g)) INDEX_EXPECTATIONS.set(match[2], {
  table: match[3],
  definition: normalizeDefinition(`(${match[4]})`),
  keyColumns: [...match[4].matchAll(/"([^"]+)"/g)].map((column) => column[1]),
  unique: Boolean(match[1]),
})
export function getDecisionGateExpectedCatalog() {
  return {
    tables: [...DECISION_GATE_TABLES],
    columns: [...COLUMN_EXPECTATIONS.values()],
    migrations: [...DECISION_GATE_MIGRATIONS],
    constraints: [...CONSTRAINT_EXPECTATIONS].map(([name, value]) => ({ name, ...value })),
    indexes: [...INDEX_EXPECTATIONS].map(([name, value]) => ({ name, ...value })),
    plans: MIGRATIONS.filter((migration) => isDecisionMigration(migration.name)).map((migration) => ({ name: migration.name, ...decisionMigrationPlan(migration) })),
  }
}

export async function getDecisionGateInfrastructureHealth(client: PoolClient, schema: string, applied: readonly string[], incomplete: readonly string[] = []) {
  const [tablesResult, columnsResult, indexesResult, constraintsResult, provenanceResult, integrityResult] = await Promise.all([
    client.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])`, [schema, [...DECISION_GATE_TABLES]]),
    client.query<{ table_name: string; column_name: string; data_type: string; character_maximum_length: number | null; datetime_precision: number | null; is_nullable: string; column_default: string | null }>(`SELECT table_name, column_name, data_type, character_maximum_length, datetime_precision, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND (table_name = ANY($2::text[]) OR (table_name = 'roadmap_items' AND column_name = ANY($3::text[]))) ORDER BY table_name, ordinal_position`, [schema, [...DECISION_GATE_TABLES], [...DECISION_GATE_COLUMNS]]),
    client.query<{ name: string; valid: boolean; unique: boolean; table_name: string; definition: string; key_columns: string[] }>(`SELECT c.relname AS name, i.indisvalid AS valid, i.indisunique AS unique, t.relname table_name, pg_get_indexdef(i.indexrelid) definition,
      COALESCE(ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinal) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum WHERE key.ordinal <= i.indnkeyatts ORDER BY key.ordinal), ARRAY[]::text[]) key_columns
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = ANY($2::text[])`, [schema, [...DECISION_GATE_INDEXES]]),
    client.query<{ constraint_name: string; table_name: string; constraint_type: string; valid: boolean; definition: string; key_columns: string[] }>(`SELECT c.conname constraint_name, t.relname table_name, c.contype constraint_type, c.convalidated valid, pg_get_constraintdef(c.oid) definition,
        CASE WHEN c.contype IN ('p','u') THEN COALESCE(ARRAY(
          SELECT a.attname::text FROM unnest(backing.indkey) WITH ORDINALITY AS key(attnum, ordinal)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=key.attnum
          WHERE key.ordinal <= backing.indnkeyatts ORDER BY key.ordinal
        ), ARRAY[]::text[]) ELSE ARRAY[]::text[] END key_columns
      FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace JOIN pg_class t ON t.oid=c.conrelid
      LEFT JOIN pg_index backing ON backing.indexrelid=c.conindid
      WHERE n.nspname=$1 AND c.conname=ANY($2::text[])`, [schema, [...DECISION_GATE_CONSTRAINTS]]),
    client.query<{ total: unknown; null_count: unknown; unknown_count: unknown; legacy_link_drift: unknown }>(`SELECT COUNT(*)::bigint total,
      COUNT(*) FILTER (WHERE now_commitment_provenance IS NULL)::bigint null_count,
      COUNT(*) FILTER (WHERE now_commitment_provenance NOT IN ('LEGACY_UNGATED','NATIVE_GATED'))::bigint unknown_count,
      COUNT(*) FILTER (WHERE now_commitment_provenance='LEGACY_UNGATED' AND now_decision_record_id IS NOT NULL)::bigint legacy_link_drift
      FROM "${schema}".roadmap_items`).catch(() => ({ rows: [] })),
    client.query<{ plan_violations: unknown; reservation_violations: unknown }>(`SELECT
      (SELECT COUNT(*) FROM "${schema}".portfolio_capacity_plans WHERE
        (state='ACTIVE' AND active_workspace_id IS DISTINCT FROM workspace_id) OR
        (state<>'ACTIVE' AND active_workspace_id IS NOT NULL))::bigint plan_violations,
      (SELECT COUNT(*) FROM "${schema}".portfolio_capacity_reservations WHERE NOT (
        (state='STAGED' AND active_roadmap_item_id IS NULL AND released_at IS NULL) OR
        (state='ACTIVE' AND active_roadmap_item_id=roadmap_item_id AND released_at IS NULL) OR
        (state='RELEASED' AND active_roadmap_item_id IS NULL AND released_at IS NOT NULL)
      ))::bigint reservation_violations`).catch(() => ({ rows: [] })),
  ]);
  const presentTables = new Set(tablesResult.rows.map((row) => row.table_name));
  const columnsByName = new Map(columnsResult.rows.filter((row) => row.table_name === "roadmap_items" || !row.table_name).map((row) => [row.column_name, row]));
  const actualColumnsByTable = new Map<string, typeof columnsResult.rows>()
  for (const row of columnsResult.rows) {
    if (!row.table_name || row.table_name === "roadmap_items") continue
    actualColumnsByTable.set(row.table_name, [...(actualColumnsByTable.get(row.table_name) ?? []), row])
  }
  const tableShapes = DECISION_GATE_TABLES.map((name) => {
    const expected = [...COLUMN_EXPECTATIONS.values()].filter((column) => column.table === name)
    const actual = actualColumnsByTable.get(name) ?? []
    const structureMatches = actual.length === expected.length && expected.every((column) => {
      const row = actual.find((candidate) => candidate.column_name === column.name)
      return Boolean(row && row.data_type === column.type
        && (row.character_maximum_length ?? null) === column.maxLength
        && (row.datetime_precision ?? null) === column.datetimePrecision
        && (row.is_nullable === "YES") === column.nullable
        && normalizeColumnDefault(row.column_default) === column.default)
    })
    const expectedEvidence = expected.map((column) => ({ name: column.name, type: column.type, maxLength: column.maxLength, datetimePrecision: column.datetimePrecision, nullable: column.nullable, default: sanitizeDefaultEvidence(column.default) }))
    const actualEvidence = actual.map((column) => ({ name: column.column_name, type: column.data_type, maxLength: column.character_maximum_length ?? null, datetimePrecision: column.datetime_precision ?? null, nullable: column.is_nullable === "YES", default: sanitizeDefaultEvidence(column.column_default) }))
    return { name, structureMatches, status: structureMatches ? "MATCHED" : "DRIFTED", expectedColumns: expectedEvidence, actualColumns: actualEvidence }
  })
  const indexesByName = new Map(indexesResult.rows.map((row) => [row.name, row]));
  const tables = DECISION_GATE_TABLES.map((name) => ({ name, present: presentTables.has(name) }));
  const columns = DECISION_GATE_COLUMNS.map((name) => {
    const row = columnsByName.get(name)
    const expected = COLUMN_EXPECTATIONS.get(`roadmap_items.${name}`)
    const structureMatches = Boolean(row && expected && row.data_type === expected.type
      && (row.character_maximum_length ?? null) === expected.maxLength
      && (row.datetime_precision ?? null) === expected.datetimePrecision
      && (row.is_nullable === "YES") === expected.nullable
      && normalizeColumnDefault(row.column_default) === expected.default)
    return { name, present: Boolean(row), nullable: row?.is_nullable !== "NO", default: row?.column_default ?? null, structureMatches }
  });
  const indexes = DECISION_GATE_INDEXES.map((name) => {
    const row = indexesByName.get(name), expected = INDEX_EXPECTATIONS.get(name)
    const structureMatches = Boolean(row && expected && row.table_name === expected.table && row.unique === expected.unique
      && JSON.stringify(row.key_columns ?? []) === JSON.stringify(expected.keyColumns)
      && normalizeIndexKeys(row.definition) === expected.definition)
    const state = row?.valid === true && structureMatches ? "ACTIVE" : row ? "FAILED_OR_MISMATCHED" : "MISSING"
    return { name, present: Boolean(row), valid: row?.valid === true, table: row?.table_name ?? null, definition: row?.definition ?? null, structureMatches, state, status: structureMatches ? "MATCHED" : row ? "DRIFTED" : "MISSING", expectedKeyColumns: expected?.keyColumns ?? [], actualKeyColumns: row?.key_columns ?? [] }
  });
  const constraintsByName = new Map(constraintsResult.rows.map((row) => [row.constraint_name, row]));
  const constraints = DECISION_GATE_CONSTRAINTS.map((name) => {
    const row = constraintsByName.get(name)
    const expected = CONSTRAINT_EXPECTATIONS.get(name)
    const exactKeys = Boolean(row && expected && JSON.stringify(row.key_columns ?? []) === JSON.stringify(expected.keyColumns))
    const exactDefinition = Boolean(row && expected && (
      row.constraint_type === "p" ? true : normalizeConstraintDefinition(row.definition, row.constraint_type) === expected.definition
    ))
    const structureMatches = Boolean(row && expected && row.table_name === expected.table && row.constraint_type === expected.type && exactKeys && exactDefinition)
    return { name, present: Boolean(row), table: row?.table_name ?? null, type: row?.constraint_type ?? null, valid: row?.valid === true, definition: row?.definition ?? null, structureMatches, status: structureMatches ? "MATCHED" : row ? "DRIFTED" : "MISSING", expectedKeyColumns: expected?.keyColumns ?? [], actualKeyColumns: row?.key_columns ?? [] }
  });
  const count = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.MAX_SAFE_INTEGER;
  const provenanceRow = provenanceResult.rows[0];
  const provenance = { available: Boolean(provenanceRow), total: count(provenanceRow?.total), nullCount: count(provenanceRow?.null_count), unknownCount: count(provenanceRow?.unknown_count), legacyLinkDrift: count(provenanceRow?.legacy_link_drift) };
  const integrityRow = integrityResult.rows[0];
  const integrity = { available: Boolean(integrityRow), planViolations: count(integrityRow?.plan_violations), reservationViolations: count(integrityRow?.reservation_violations) };
  const provenanceColumn = columnsByName.get("now_commitment_provenance");
  const columnsHealthy = columns.every((item) => item.present && item.structureMatches) && Boolean(provenanceColumn?.column_default?.includes("LEGACY_UNGATED"));
  const repairApplied = applied.includes("042_native_decision_gates_repair")
  const migrationReceipts = DECISION_GATE_MIGRATIONS.map((name) => ({
    name,
    applied: applied.includes(name),
    status: name === "039_native_decision_gates" && !applied.includes(name) && repairApplied ? "REPAIRED_BY" : applied.includes(name) ? "APPLIED" : incomplete.includes(name) ? "INCOMPLETE" : "MISSING",
    repairedBy: name === "039_native_decision_gates" && !applied.includes(name) && repairApplied ? "042_native_decision_gates_repair" : null,
  }));
  const receiptsReady = (applied.includes("039_native_decision_gates") || repairApplied) && applied.includes("040_release_authorization") && applied.includes("041_portfolio_capacity_ledger") && applied.includes("043_decision_evidence_refs") && applied.includes("044_now_policy_application_evidence") && applied.includes("045_now_gate_shadow_evaluations")
  const migrationReady = receiptsReady && tables.every((item) => item.present) && tableShapes.every((item) => item.structureMatches) && columnsHealthy && constraints.every((item) => item.present && item.valid && item.structureMatches) && indexes.every((item) => item.state === "ACTIVE") && provenance.available && provenance.nullCount === 0 && provenance.unknownCount === 0 && provenance.legacyLinkDrift === 0 && integrity.available && integrity.planViolations === 0 && integrity.reservationViolations === 0;
  return { migrationReceipts, tables, tableShapes, columns, constraints, indexes, provenance, integrity, migrationReady, capacityMetadataReady: false, runtimeEnforcementReady: false };
}

const REPAIR_039_TABLES = new Set(["review_requests", "review_revisions", "review_options", "decision_records", "decision_applications"])
const REPAIR_039_INDEXES = new Set(["idx_review_requests_workspace_state", "idx_review_revisions_request_id", "idx_review_options_revision_id", "idx_decision_records_workspace_decided", "idx_decision_records_request_id", "idx_decision_records_option_id", "idx_decision_applications_target"])
const REPAIR_039_CONSTRAINTS = new Set([
  "review_requests_pkey", "idx_review_requests_subject_gate", "idx_review_requests_current_revision",
  "review_revisions_pkey", "idx_review_revisions_request_number", "idx_review_revisions_request_fingerprint",
  "review_options_pkey", "idx_review_options_revision_action", "decision_records_pkey",
  "idx_decision_records_revision", "idx_decision_records_idempotency", "decision_applications_pkey",
  "idx_decision_applications_receipt", "idx_decision_applications_decision_continuation",
  "chk_roadmap_items_commitment_provenance_not_null",
])

type Repair039State = { checkPresent: boolean; checkValid: boolean }
async function inspectRepair039State(client: PoolClient, schema: string): Promise<Repair039State> {
  const health = await getDecisionGateInfrastructureHealth(client, schema, [])
  const expectedColumns = [...COLUMN_EXPECTATIONS.values()].filter((column) => REPAIR_039_TABLES.has(column.table) && column.name !== "source_fingerprint")
  const tablesExact = await exactColumnsMatch(client, schema, REPAIR_039_TABLES, expectedColumns)
  const missingTable = health.tables.find((table) => REPAIR_039_TABLES.has(table.name) && !table.present)
  const provenanceColumn = health.columns.find((column) => column.name === "now_commitment_provenance")
  const badConstraint = health.constraints.find((constraint) => REPAIR_039_CONSTRAINTS.has(constraint.name) && constraint.present && !constraint.structureMatches)
  const badIndex = health.indexes.find((index) => REPAIR_039_INDEXES.has(index.name) && index.present && index.state !== "ACTIVE")
  if (missingTable || !tablesExact || !provenanceColumn?.present || !provenanceColumn.structureMatches || !provenanceColumn.default?.includes("LEGACY_UNGATED") || badConstraint || badIndex) {
    throw new Error(`Migration 042 refused unknown partial-039 catalog shape${missingTable ? `: missing ${missingTable.name}` : !tablesExact ? ": table column fingerprint mismatch" : badConstraint ? `: mismatched ${badConstraint.name}` : badIndex ? `: mismatched ${badIndex.name}` : ": invalid provenance column"}.`)
  }
  const check = health.constraints.find((constraint) => constraint.name === "chk_roadmap_items_commitment_provenance_not_null")
  return { checkPresent: check?.present === true, checkValid: check?.present === true && check.valid && check.structureMatches }
}

async function assertRepair039Postconditions(client: PoolClient, schema: string) {
  const health = await getDecisionGateInfrastructureHealth(client, schema, [])
  const repairColumns = [...COLUMN_EXPECTATIONS.values()].filter((column) => REPAIR_039_TABLES.has(column.table) && column.name !== "source_fingerprint")
  const healthy = health.tables.filter((table) => REPAIR_039_TABLES.has(table.name)).every((table) => table.present)
    && await exactColumnsMatch(client, schema, REPAIR_039_TABLES, repairColumns)
    && health.columns.every((column) => column.present && column.structureMatches)
    && health.constraints.filter((constraint) => REPAIR_039_CONSTRAINTS.has(constraint.name)).every((constraint) => constraint.present && constraint.valid && constraint.structureMatches)
    && health.indexes.filter((index) => REPAIR_039_INDEXES.has(index.name)).every((index) => index.state === "ACTIVE")
    && health.provenance.available && health.provenance.nullCount === 0 && health.provenance.unknownCount === 0 && health.provenance.legacyLinkDrift === 0
  if (!healthy) throw new Error("Migration 042 postcondition failed: repaired 039 catalog or provenance integrity is incomplete.")
}

const DECISION_MIGRATION_POSTCONDITIONS = {
  "040_release_authorization": {
    tables: new Set<string>(["review_revisions", "release_runs", "release_run_tasks", "release_dispatches"]),
    constraints: new Set<string>(["release_runs_pkey", "idx_release_runs_scope_fingerprint", "idx_release_runs_authorization_decision", "release_run_tasks_pkey", "idx_release_run_tasks_run_task", "release_dispatches_pkey", "idx_release_dispatches_decision_continuation", "idx_release_dispatches_idempotency"]),
    indexes: new Set<string>(["idx_review_revisions_request_source", "idx_release_runs_workspace_state", "idx_release_runs_repository_pr", "idx_release_run_tasks_task_run", "idx_release_dispatches_claim", "idx_release_dispatches_run_status"]),
  },
  "041_portfolio_capacity_ledger": {
    tables: new Set<string>(["portfolio_capacity_plans", "portfolio_capacity_reservations", "portfolio_capacity_operations"]),
    constraints: new Set<string>(["portfolio_capacity_plans_pkey", "idx_capacity_plans_workspace_policy", "idx_capacity_plans_active_workspace", "chk_capacity_plans_active_claim", "portfolio_capacity_reservations_pkey", "idx_capacity_reservations_plan_item", "idx_capacity_reservations_active_item", "chk_capacity_reservations_state_claim", "portfolio_capacity_operations_pkey", "idx_capacity_operations_workspace_key"]),
    indexes: new Set<string>(["idx_capacity_plans_workspace_state", "idx_capacity_reservations_plan_state", "idx_capacity_reservations_item_history", "idx_capacity_reservations_decision", "idx_capacity_operations_plan_action_created"]),
  },
  "043_decision_evidence_refs": {
    tables: new Set<string>(["decision_evidence_refs"]),
    constraints: new Set<string>(["decision_evidence_refs_pkey", "idx_decision_evidence_refs_revision_authority"]),
    indexes: new Set<string>(["idx_decision_evidence_refs_subject"]),
  },
  "044_now_policy_application_evidence": {
    tables: new Set<string>(["now_policy_application_evidence"]),
    constraints: new Set<string>(["now_policy_application_evidence_pkey", "idx_now_policy_evidence_receipt"]),
    indexes: new Set<string>(["idx_now_policy_evidence_workspace_created"]),
  },
  "045_now_gate_shadow_evaluations": {
    tables: new Set<string>(["now_gate_evaluations"]),
    constraints: new Set<string>(["now_gate_evaluations_pkey", "chk_now_gate_evaluations_mode", "chk_now_gate_evaluations_outcome", "chk_now_gate_evaluations_actor"]),
    indexes: new Set<string>(["idx_now_gate_evaluations_workspace_created", "idx_now_gate_evaluations_workspace_outcome_created", "idx_now_gate_evaluations_item_created"]),
  },
} as const

async function exactColumnsMatch(client: PoolClient, schema: string, tables: ReadonlySet<string>, expected: ColumnExpectation[]) {
  const { rows } = await client.query<{ table_name: string; column_name: string; data_type: string; character_maximum_length: number | null; datetime_precision: number | null; is_nullable: string; column_default: string | null }>(
    `SELECT table_name, column_name, data_type, character_maximum_length, datetime_precision, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[]) ORDER BY table_name, ordinal_position`,
    [schema, [...tables]],
  )
  return rows.length === expected.length && expected.every((column) => {
    const row = rows.find((candidate) => candidate.table_name === column.table && candidate.column_name === column.name)
    return Boolean(row && row.data_type === column.type
      && (row.character_maximum_length ?? null) === column.maxLength
      && (row.datetime_precision ?? null) === column.datetimePrecision
      && (row.is_nullable === "YES") === column.nullable
      && normalizeColumnDefault(row.column_default) === column.default)
  })
}

async function assertDecisionMigrationPostconditions(client: PoolClient, schema: string, migrationName: string) {
  if (migrationName === "039_native_decision_gates" || migrationName === "042_native_decision_gates_repair") {
    await assertRepair039Postconditions(client, schema)
    return
  }
  const expected = DECISION_MIGRATION_POSTCONDITIONS[migrationName as keyof typeof DECISION_MIGRATION_POSTCONDITIONS]
  if (!expected) return
  const health = await getDecisionGateInfrastructureHealth(client, schema, [])
  const tables = health.tables.filter((table) => expected.tables.has(table.name))
  const constraints = health.constraints.filter((constraint) => expected.constraints.has(constraint.name))
  const indexes = health.indexes.filter((index) => expected.indexes.has(index.name))
  const healthy = tables.length === expected.tables.size
    && tables.every((table) => table.present)
    && await exactColumnsMatch(client, schema, expected.tables, [...COLUMN_EXPECTATIONS.values()].filter((column) => expected.tables.has(column.table)))
    && constraints.length === expected.constraints.size
    && constraints.every((constraint) => constraint.present && constraint.valid && constraint.structureMatches)
    && indexes.length === expected.indexes.size
    && indexes.every((index) => index.state === "ACTIVE")
  if (!healthy) throw new Error(`Migration ${migrationName} postcondition failed: catalog is incomplete or mismatched.`)
  if (migrationName === "040_release_authorization") {
    const sourceColumn = await client.query<{ present: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='review_revisions' AND column_name='source_fingerprint'
    ) present`, [schema])
    if (sourceColumn.rows[0]?.present !== true) throw new Error("Migration 040 postcondition failed: review_revisions.source_fingerprint is missing.")
  }
}

type DecisionRunRow = {
  attempt_id: string
  plan_fingerprint: string
  next_step: number
  pending_job_id: string | null
  pending_step: number | null
  executing_step: number | null
  executing_started_at: string | Date | null
  claim_epoch: number
}
const EXECUTING_RECOVERY_GRACE_MS = 2 * 60 * 1000

function asyncStepObject(step: DecisionMigrationStep) {
  return step.sql?.match(/INDEX\s+ASYNC(?:\s+IF\s+NOT\s+EXISTS)?\s+"([^"]+)"/i)?.[1]
    ?? step.sql?.match(/ALTER\s+TABLE\s+ASYNC\s+"([^"]+)"/i)?.[1]
    ?? null
}

async function asyncStepIsComplete(client: PoolClient, schema: string, step: DecisionMigrationStep) {
  const health = await getDecisionGateInfrastructureHealth(client, schema, [])
  const indexName = step.sql?.match(/INDEX\s+ASYNC(?:\s+IF\s+NOT\s+EXISTS)?\s+"([^"]+)"/i)?.[1]
  if (indexName) return health.indexes.some((index) => index.name === indexName && index.state === "ACTIVE")
  const constraintName = step.sql?.match(/VALIDATE\s+CONSTRAINT\s+"([^"]+)"/i)?.[1]
  return Boolean(constraintName && health.constraints.some((constraint) => constraint.name === constraintName && constraint.valid && constraint.structureMatches))
}

async function stepIsComplete(client: PoolClient, schema: string, migrationName: DecisionMigrationName, step: DecisionMigrationStep) {
  if (step.async) return asyncStepIsComplete(client, schema, step)
  if (step.kind === "backfill") {
    const result = await client.query<{ remaining: string }>(`SELECT COUNT(*)::bigint remaining FROM "${schema}".roadmap_items WHERE now_commitment_provenance IS NULL`)
    return result.rows[0]?.remaining === "0"
  }
  const table = step.sql?.match(/CREATE TABLE IF NOT EXISTS "([^"]+)"/i)?.[1]
  if (table) {
    const tables = new Set([table])
    const expected = [...COLUMN_EXPECTATIONS.values()].filter((column) => column.table === table && !((migrationName === "039_native_decision_gates" || migrationName === "042_native_decision_gates_repair") && column.name === "source_fingerprint"))
    return exactColumnsMatch(client, schema, tables, expected)
  }
  const column = step.sql?.match(/ALTER TABLE "([^"]+)" (?:ADD COLUMN IF NOT EXISTS "([^"]+)"|ALTER COLUMN "([^"]+)" SET DEFAULT)/i)
  if (column) {
    const expected = COLUMN_EXPECTATIONS.get(`${column[1]}.${column[2] ?? column[3]}`)
    if (!expected) return false
    const { rows } = await client.query<{ table_name: string; column_name: string; data_type: string; character_maximum_length: number | null; datetime_precision: number | null; is_nullable: string; column_default: string | null }>(`SELECT table_name, column_name, data_type, character_maximum_length, datetime_precision, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3`, [schema, expected.table, expected.name])
    const row = rows[0]
    return Boolean(row && row.data_type === expected.type && (row.character_maximum_length ?? null) === expected.maxLength && (row.datetime_precision ?? null) === expected.datetimePrecision && (row.is_nullable === "YES") === expected.nullable && normalizeColumnDefault(row.column_default) === expected.default)
  }
  const constraint = step.sql?.match(/ADD CONSTRAINT "([^"]+)"/i)?.[1]
  if (constraint) {
    const health = await getDecisionGateInfrastructureHealth(client, schema, [])
    // ADD ... CHECK NOT VALID owns existence and structure only. The following
    // ALTER TABLE ASYNC ... VALIDATE step separately owns convalidated=true.
    return health.constraints.some((item) => item.name === constraint && item.present && item.structureMatches)
  }
  return false
}

async function runOneProvenanceBackfillBatch(client: PoolClient, schema: string, log: string[]) {
  const { rows } = await client.query<{ id: string; estimated_bytes: string }>(`
    SELECT id, pg_column_size(ri)::bigint AS estimated_bytes
    FROM "${schema}".roadmap_items ri
    WHERE now_commitment_provenance IS NULL
    ORDER BY id
    LIMIT ${DSQL_WRITE_LIMITS.maxRows}`)
  if (rows.length === 0) return true
  const ids: string[] = []
  let bytes = 0
  for (const row of rows) {
    const rowBytes = toSafeNumber(row.estimated_bytes)
    if (rowBytes > DSQL_WRITE_LIMITS.maxBytes) throw new Error(`Roadmap item ${row.id} exceeds Aurora DSQL's transaction byte limit.`)
    if (ids.length >= DSQL_WRITE_LIMITS.maxRows || bytes + rowBytes > DSQL_WRITE_LIMITS.maxBytes) break
    ids.push(row.id); bytes += rowBytes
  }
  if (ids.length === 0) throw new Error("Could not plan a bounded provenance backfill batch.")
  const result = await client.query(`UPDATE "${schema}".roadmap_items SET now_commitment_provenance='LEGACY_UNGATED' WHERE id=ANY($1::uuid[]) AND now_commitment_provenance IS NULL`, [ids])
  log.push(`  ✓ provenance backfill batch: ${result.rowCount ?? 0} rows`)
  return false
}

async function advanceDecisionMigration(client: PoolClient, schema: string, migration: { name: DecisionMigrationName; filePath: string }, log: string[], repairState?: Repair039State) {
  const plan = decisionMigrationPlan(migration)
  const claimId = randomUUID()
  await client.query(`CREATE TABLE IF NOT EXISTS "${schema}"._migration_execution_state (
    migration_name VARCHAR(255) NOT NULL,
    attempt_id UUID NOT NULL,
    plan_version INTEGER NOT NULL,
    plan_fingerprint CHAR(64) NOT NULL,
    next_step INTEGER NOT NULL DEFAULT 0,
    pending_step INTEGER,
    pending_job_id VARCHAR(255),
    executing_step INTEGER,
    executing_started_at TIMESTAMP(3),
    claimed_by UUID,
    claim_expires_at TIMESTAMP(3),
    claim_epoch INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT _migration_execution_state_pkey PRIMARY KEY (migration_name)
  )`)
  for (const upgrade of [
    "pending_step INTEGER", "pending_job_id VARCHAR(255)", "executing_step INTEGER", "executing_started_at TIMESTAMP(3)",
    "claimed_by UUID", "claim_expires_at TIMESTAMP(3)", "claim_epoch INTEGER", "last_error TEXT",
  ]) await client.query(`ALTER TABLE "${schema}"._migration_execution_state ADD COLUMN IF NOT EXISTS ${upgrade}`)
  let run = (await client.query<DecisionRunRow>(`SELECT attempt_id, plan_fingerprint, next_step, pending_job_id, pending_step, executing_step, executing_started_at, claim_epoch FROM "${schema}"._migration_execution_state WHERE migration_name=$1`, [migration.name])).rows[0]
  if (!run) {
    const attemptId = randomUUID()
    try {
      await client.query("BEGIN")
      await client.query(`INSERT INTO "${schema}"._migration_execution_state (migration_name, attempt_id, plan_version, plan_fingerprint) VALUES ($1,$2,$3,$4)`, [migration.name, attemptId, plan.version, plan.fingerprint])
      await client.query(`INSERT INTO "${schema}"._prisma_migrations (id, migration_name) VALUES ($1,$2)`, [attemptId, migration.name])
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      // A concurrent initializer wins the primary-key race; only its attempt may advance.
      if (!(error instanceof Error) || !/duplicate|unique/i.test(error.message)) throw error
    }
    run = (await client.query<DecisionRunRow>(`SELECT attempt_id, plan_fingerprint, next_step, pending_job_id, pending_step, executing_step, executing_started_at, claim_epoch FROM "${schema}"._migration_execution_state WHERE migration_name=$1`, [migration.name])).rows[0]
  }
  if (!run) throw new Error(`Migration ${migration.name} could not load its durable execution state.`)
  if (run.plan_fingerprint !== plan.fingerprint) throw new Error(`Migration ${migration.name} plan fingerprint changed; refusing unsafe resume.`)
  const claimed = await client.query<{ claim_epoch: number }>(`UPDATE "${schema}"._migration_execution_state SET claimed_by=$2, claim_epoch=COALESCE(claim_epoch,0)+1, claim_expires_at=CURRENT_TIMESTAMP + INTERVAL '50 seconds', updated_at=CURRENT_TIMESTAMP WHERE migration_name=$1 AND (claimed_by IS NULL OR claim_expires_at < CURRENT_TIMESTAMP) RETURNING claim_epoch`, [migration.name, claimId])
  if (claimed.rowCount !== 1) return { status: 409, state: "CLAIMED", attemptId: run.attempt_id, nextStep: run.next_step }
  const claimEpoch = claimed.rows[0]?.claim_epoch
  if (!Number.isInteger(claimEpoch)) throw new Error(`Migration ${migration.name} claim did not return a fencing epoch.`)
  try {
    if (run.pending_job_id) {
      if (run.pending_step !== run.next_step) throw new Error(`Migration ${migration.name} has an ambiguous async job/step correlation.`)
      const jobs = await client.query<{ status: string; details: string | null }>(`SELECT status, details FROM sys.jobs WHERE job_id=$1`, [run.pending_job_id])
      const job = jobs.rows[0]
      if (!job) throw new Error(`Migration ${migration.name} async job ${run.pending_job_id} is unknown.`)
      if (["submitted", "processing", "pending", "running", "in_progress"].includes(job.status.toLowerCase())) return { status: 202, state: "WAITING", attemptId: run.attempt_id, nextStep: run.next_step, jobId: run.pending_job_id }
      if (!["succeeded", "successful", "completed"].includes(job.status.toLowerCase())) throw new Error(`Migration ${migration.name} async job ${run.pending_job_id} failed: ${job.details ?? job.status}`)
      const advanced = await client.query(`UPDATE "${schema}"._migration_execution_state SET next_step=next_step+1, pending_step=NULL, pending_job_id=NULL, last_error=NULL WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch])
      if (advanced.rowCount !== 1) throw new Error(`Migration ${migration.name} lost its fenced claim before advancing.`)
      return { status: 202, state: "ADVANCED", attemptId: run.attempt_id, nextStep: run.next_step + 1 }
    }
    const step = plan.steps[run.next_step]
    if (!step) {
      await assertDecisionMigrationPostconditions(client, schema, migration.name)
      const heartbeat = await client.query(`UPDATE "${schema}"._migration_execution_state SET claim_expires_at=CURRENT_TIMESTAMP + INTERVAL '50 seconds' WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3 RETURNING migration_name`, [migration.name, claimId, claimEpoch])
      if (heartbeat.rowCount !== 1) throw new Error(`Migration ${migration.name} lost its fenced claim before writing the finished receipt.`)
      const receipt = await client.query(`UPDATE "${schema}"._prisma_migrations SET finished_at=CURRENT_TIMESTAMP WHERE id=$1 AND finished_at IS NULL RETURNING id`, [run.attempt_id])
      if (receipt.rowCount !== 1) throw new Error(`Migration ${migration.name} cannot finish without its exact durable attempt receipt.`)
      const removed = await client.query(`DELETE FROM "${schema}"._migration_execution_state WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch])
      if (removed.rowCount !== 1) throw new Error(`Migration ${migration.name} lost its fenced claim before completion.`)
      return { status: 200, state: "COMPLETE", attemptId: run.attempt_id, nextStep: run.next_step }
    }
    if (run.executing_step != null) {
      if (run.executing_step !== run.next_step) throw new Error(`Migration ${migration.name} has an ambiguous EXECUTING step.`)
      if (await stepIsComplete(client, schema, migration.name, step)) {
        const reconciled = await client.query(`UPDATE "${schema}"._migration_execution_state SET next_step=next_step+1, executing_step=NULL, executing_started_at=NULL, last_error=NULL WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch])
        if (reconciled.rowCount !== 1) throw new Error(`Migration ${migration.name} lost its fenced claim while reconciling catalog state.`)
        return { status: 202, state: "ADVANCED", attemptId: run.attempt_id, nextStep: run.next_step + 1 }
      }
      if (step.async) {
        const objectName = asyncStepObject(step)
        const discovered = objectName ? await client.query<{ job_id: string; status: string }>(`SELECT job_id, status FROM sys.jobs WHERE object_name=$1 ORDER BY job_id DESC LIMIT 2`, [`${schema}.${objectName}`]) : { rows: [] }
        if (discovered.rows.length === 1) {
          const correlated = await client.query(`UPDATE "${schema}"._migration_execution_state SET pending_step=$4, pending_job_id=$5, executing_step=NULL, executing_started_at=NULL, last_error=NULL WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch, run.next_step, discovered.rows[0].job_id])
          if (correlated.rowCount !== 1) throw new Error(`Migration ${migration.name} lost its fenced claim while correlating the async job.`)
          return { status: 202, state: "WAITING", attemptId: run.attempt_id, nextStep: run.next_step, jobId: discovered.rows[0].job_id }
        }
        if (discovered.rows.length > 1) return { status: 202, state: "RECONCILING", attemptId: run.attempt_id, nextStep: run.next_step }
      }
      const startedAt = run.executing_started_at ? new Date(run.executing_started_at).getTime() : Number.NaN
      if (!Number.isFinite(startedAt) || Date.now() - startedAt < EXECUTING_RECOVERY_GRACE_MS) return { status: 202, state: "RECONCILING", attemptId: run.attempt_id, nextStep: run.next_step }
      const recovered = await client.query(`UPDATE "${schema}"._migration_execution_state SET executing_step=NULL, executing_started_at=NULL WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch])
      if (recovered.rowCount !== 1) throw new Error(`Migration ${migration.name} lost its fenced claim during zero-job recovery.`)
    }
    if (await stepIsComplete(client, schema, migration.name, step)) {
      const reconciled = await client.query(`UPDATE "${schema}"._migration_execution_state SET next_step=next_step+1, last_error=NULL WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch])
      if (reconciled.rowCount !== 1) throw new Error(`Migration ${migration.name} lost its fenced claim while reconciling a completed step.`)
      return { status: 202, state: "ADVANCED", attemptId: run.attempt_id, nextStep: run.next_step + 1 }
    }
    if (step.kind === "backfill") {
      const intent = await client.query(`UPDATE "${schema}"._migration_execution_state SET executing_step=$4, executing_started_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch, run.next_step])
      if (intent.rowCount !== 1) throw new Error(`Migration ${migration.name} lost its fenced claim before the backfill step.`)
      const done = await runOneProvenanceBackfillBatch(client, schema, log)
      const persisted = done
        ? await client.query(`UPDATE "${schema}"._migration_execution_state SET next_step=next_step+1, executing_step=NULL, executing_started_at=NULL, last_error=NULL WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch])
        : await client.query(`UPDATE "${schema}"._migration_execution_state SET executing_step=NULL, executing_started_at=NULL, last_error=NULL WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch])
      if (persisted.rowCount !== 1) throw new Error(`Migration ${migration.name} lost its fenced claim after the backfill step.`)
      return { status: 202, state: done ? "ADVANCED" : "BACKFILLING", attemptId: run.attempt_id, nextStep: run.next_step + (done ? 1 : 0) }
    }
    if ((repairState?.checkPresent && /ADD\s+CONSTRAINT\s+"chk_roadmap_items_commitment_provenance_not_null"/i.test(step.sql!))
      || (repairState?.checkValid && /VALIDATE\s+CONSTRAINT\s+"chk_roadmap_items_commitment_provenance_not_null"/i.test(step.sql!))) {
      const skipped = await client.query(`UPDATE "${schema}"._migration_execution_state SET next_step=next_step+1, last_error=NULL WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch])
      if (skipped.rowCount !== 1) throw new Error(`Migration ${migration.name} lost its fenced claim while skipping a verified step.`)
      return { status: 202, state: "ADVANCED", attemptId: run.attempt_id, nextStep: run.next_step + 1 }
    }
    const executableSql = process.env.DATABASE_URL ? step.sql!.replace(/\bINDEX ASYNC\b/gi, "INDEX").replace(/ALTER\s+TABLE\s+ASYNC/gi, "ALTER TABLE") : step.sql!
    const intent = await client.query(`UPDATE "${schema}"._migration_execution_state SET executing_step=$4, executing_started_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch, run.next_step])
    if (intent.rowCount !== 1) throw new Error(`Migration ${migration.name} lost its fenced claim before executing step ${step.id}.`)
    const result = await client.query<{ job_id?: string }>(executableSql)
    if (step.async && !process.env.DATABASE_URL) {
      const jobId = result.rows[0]?.job_id
      if (!jobId) throw new Error(`Migration ${migration.name} async step ${step.id} returned no job_id.`)
      const persisted = await client.query(`UPDATE "${schema}"._migration_execution_state SET pending_step=$4, pending_job_id=$5, executing_step=NULL, executing_started_at=NULL, last_error=NULL WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch, run.next_step, jobId])
      if (persisted.rowCount !== 1) throw new Error(`Migration ${migration.name} lost its fenced claim after launching async DDL; EXECUTING intent remains for reconciliation.`)
      return { status: 202, state: "WAITING", attemptId: run.attempt_id, nextStep: run.next_step, jobId }
    }
    const advanced = await client.query(`UPDATE "${schema}"._migration_execution_state SET next_step=next_step+1, executing_step=NULL, executing_started_at=NULL, last_error=NULL WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch])
    if (advanced.rowCount !== 1) throw new Error(`Migration ${migration.name} lost its fenced claim after executing step ${step.id}.`)
    return { status: 202, state: "ADVANCED", attemptId: run.attempt_id, nextStep: run.next_step + 1 }
  } catch (error) {
    await client.query(`UPDATE "${schema}"._migration_execution_state SET last_error=$4 WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch, error instanceof Error ? error.message : String(error)])
    throw error
  } finally {
    await client.query(`UPDATE "${schema}"._migration_execution_state SET claimed_by=NULL, claim_expires_at=NULL WHERE migration_name=$1 AND claimed_by=$2 AND claim_epoch=$3`, [migration.name, claimId, claimEpoch]).catch(() => undefined)
  }
}

const DSQL_WRITE_LIMITS = {
  maxRows: 3_000,
  maxBytes: 10 * 1024 * 1024,
} as const;

const RESEARCH_VOICE_BACKFILL_BATCH_SIZE = 2_500;
const RESEARCH_VOICE_COUNTER_BACKFILLS = [
  { table: "research_sessions", column: "voice_attempt_count" },
  { table: "research_sessions", column: "voice_turn_count" },
  { table: "research_sessions", column: "voice_transcript_chars" },
  { table: "research_participant_tokens", column: "voice_count" },
  { table: "research_participant_tokens", column: "voice_day_count" },
] as const;

async function backfillNullableResearchVoiceColumn(
  client: PoolClient,
  schema: string,
  target: typeof RESEARCH_VOICE_COUNTER_BACKFILLS[number],
  log: string[],
) {
  const voiceSessionsOnly = target.column === "voice_turn_count" || target.column === "voice_transcript_chars"
    ? " AND modality = 'VOICE'"
    : "";
  const valueExpression = target.column === "voice_turn_count"
    ? `COALESCE((SELECT COUNT(*)::INTEGER FROM "${schema}".research_turns AS turns WHERE turns.session_id = target.id), 0)`
    : target.column === "voice_transcript_chars"
      ? `COALESCE((SELECT SUM(char_length(content))::INTEGER FROM "${schema}".research_turns AS turns WHERE turns.session_id = target.id), 0)`
      : "0";
  let total = 0;
  while (true) {
    const result = await client.query(
      `WITH batch AS (
         SELECT id FROM "${schema}".${target.table}
         WHERE ${target.column} IS NULL${voiceSessionsOnly}
         LIMIT $1
       )
       UPDATE "${schema}".${target.table} AS target
       SET ${target.column} = ${valueExpression}
       FROM batch
       WHERE target.id = batch.id`,
      [RESEARCH_VOICE_BACKFILL_BATCH_SIZE],
    );
    const updated = result.rowCount ?? 0;
    total += updated;
    if (result.rowCount === null || result.rowCount < RESEARCH_VOICE_BACKFILL_BATCH_SIZE) break;
  }
  log.push(`  ✓ backfilled ${total} ${target.table}.${target.column} rows`);
}

const RESEARCH_CAPTURE_INDEXES = [
  "idx_research_participant_tokens_hash",
  "idx_research_participant_tokens_study_kind",
  "idx_research_sessions_resume_token",
  "idx_research_sessions_participant_token",
  "idx_research_requests_session_key",
  "idx_research_requests_session_created",
] as const;

const RESEARCH_GUIDED_UX_INDEXES = [
  "idx_research_attachments_blob_pathname",
  "idx_research_attachments_session_key",
  "idx_research_attachments_session_created",
  "idx_research_attachments_turn_created",
  "idx_research_attachments_workspace_status",
  "idx_research_voice_events_session_provider",
  "idx_research_voice_events_session_created",
] as const;

const RESEARCH_BLOB_CLEANUP_INDEXES = [
  "idx_research_blob_cleanups_pathname",
  "idx_research_blob_cleanups_workspace_retry",
] as const;

type BackfillPreflight = {
  rowCount: number;
  estimatedBytes: number;
  estimateBasis: "conservative full source-row bytes";
  available: boolean;
  passed: boolean;
};

type ResearchCapturePreflight = {
  limits: typeof DSQL_WRITE_LIMITS;
  tokenBackfill: BackfillPreflight;
  nextSequenceBackfill: BackfillPreflight;
  passed: boolean;
};

function toSafeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.MAX_SAFE_INTEGER;
}

function backfillResult(
  row: { row_count?: unknown; estimated_bytes?: unknown } | undefined,
  available: boolean
): BackfillPreflight {
  const rowCount = available ? toSafeNumber(row?.row_count) : 0;
  const estimatedBytes = available ? toSafeNumber(row?.estimated_bytes) : 0;
  return {
    rowCount,
    estimatedBytes,
    estimateBasis: "conservative full source-row bytes",
    available,
    passed:
      available &&
      rowCount <= DSQL_WRITE_LIMITS.maxRows &&
      estimatedBytes <= DSQL_WRITE_LIMITS.maxBytes,
  };
}

async function getResearchCapturePreflight(
  client: PoolClient,
  schema: string
): Promise<ResearchCapturePreflight> {
  const { rows: tableRows } = await client.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1
       AND table_name IN ('research_studies', 'research_sessions')`,
    [schema]
  );
  const tables = new Set(tableRows.map((row) => row.table_name));

  const tokenRows = tables.has("research_studies")
    ? (
        await client.query<{ row_count: string; estimated_bytes: string }>(`
          SELECT
            COUNT(*)::bigint AS row_count,
            COALESCE(SUM(pg_column_size(rs)), 0)::bigint AS estimated_bytes
          FROM "${schema}".research_studies rs
          WHERE share_token_hash IS NOT NULL
            AND share_expires_at IS NOT NULL
        `)
      ).rows
    : [];

  let sequenceRows: { row_count: string; estimated_bytes: string }[] = [];
  if (tables.has("research_sessions")) {
    const { rows: columnRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'research_sessions'
           AND column_name = 'next_sequence'
       ) AS exists`,
      [schema]
    );
    const onlyMissing = columnRows[0]?.exists ? "WHERE next_sequence IS NULL" : "";
    sequenceRows = (
      await client.query<{ row_count: string; estimated_bytes: string }>(`
        SELECT
          COUNT(*)::bigint AS row_count,
          COALESCE(SUM(pg_column_size(rs)), 0)::bigint AS estimated_bytes
        FROM "${schema}".research_sessions rs
        ${onlyMissing}
      `)
    ).rows;
  }

  const tokenBackfill = backfillResult(tokenRows[0], tables.has("research_studies"));
  const nextSequenceBackfill = backfillResult(
    sequenceRows[0],
    tables.has("research_sessions")
  );

  return {
    limits: DSQL_WRITE_LIMITS,
    tokenBackfill,
    nextSequenceBackfill,
    passed: tokenBackfill.passed && nextSequenceBackfill.passed,
  };
}

async function getResearchCaptureIndexStatus(client: PoolClient, schema: string) {
  const { rows } = await client.query<{ name: string; valid: boolean }>(
    `SELECT c.relname AS name, i.indisvalid AS valid
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1
       AND c.relname = ANY($2::text[])`,
    [schema, [...RESEARCH_CAPTURE_INDEXES]]
  );
  const validity = new Map(rows.map((row) => [row.name, row.valid]));
  const indexes = RESEARCH_CAPTURE_INDEXES.map((name) => ({
    name,
    present: validity.has(name),
    valid: validity.get(name) === true,
  }));

  return {
    indexes,
    indexesValid: indexes.every((index) => index.valid),
  };
}

async function getNamedIndexStatus(
  client: PoolClient,
  schema: string,
  expected: readonly string[],
) {
  const { rows } = await client.query<{ name: string; valid: boolean }>(
    `SELECT c.relname AS name, i.indisvalid AS valid
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1
       AND c.relname = ANY($2::text[])`,
    [schema, [...expected]],
  )
  const validity = new Map(rows.map((row) => [row.name, row.valid]))
  const indexes = expected.map((name) => ({
    name,
    present: validity.has(name),
    valid: validity.get(name) === true,
  }))
  return { indexes, indexesValid: indexes.every((index) => index.valid) }
}

async function getResearchVoiceControlPlaneReport(client: PoolClient, schema: string) {
  return getNamedIndexStatus(client, schema, RESEARCH_VOICE_CONTROL_PLANE_INDEXES)
}

async function assertResearchVoiceControlPlanePostconditions(client: PoolClient, schema: string) {
  const report = await getResearchVoiceControlPlaneReport(client, schema)
  if (!report.indexesValid) {
    const invalid = report.indexes.filter((index) => !index.valid).map((index) => index.name).join(", ")
    throw new Error(`Migration 047 postcondition failed: indexes are not ACTIVE: ${invalid}`)
  }
}

async function assertPmInterviewPostconditions(client: PoolClient, schema: string) {
  const [{ rows }, indexes] = await Promise.all([
    client.query<{ pm_table: boolean; description_column: boolean }>(
      `SELECT
        to_regclass(format('%I.pm_interviews', $1::text)) IS NOT NULL AS pm_table,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='assumptions' AND column_name='description') AS description_column`,
      [schema],
    ),
    getNamedIndexStatus(client, schema, PM_INTERVIEW_INDEXES),
  ])
  if (!rows[0]?.pm_table || !rows[0]?.description_column || !indexes.indexesValid) {
    const invalid = indexes.indexes.filter(index => !index.valid).map(index => index.name).join(", ")
    throw new Error(`Migration 050 postcondition failed: PM interview catalog is incomplete${invalid ? ` (${invalid})` : ""}.`)
  }
}

/**
 * ADR-0012 step 5. Promotion's convergence guarantee is the unique
 * (workspace_id, finding_key) index, so a receipt written while that index is
 * still building would advertise an idempotency property the database is not yet
 * enforcing — and duplicate Evidence rows created in that window are not
 * something a later rerun can undo. Verified before the receipt, like 047/050/051.
 */
async function assertResearchEvidencePromotionPostconditions(client: PoolClient, schema: string) {
  const [{ rows }, indexes] = await Promise.all([
    client.query<{ sources_table: boolean; evidence_columns: number }>(
      `SELECT
        to_regclass(format('%I.evidence_research_sources', $1::text)) IS NOT NULL AS sources_table,
        (SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema=$1 AND table_name='evidence' AND column_name IN ('research_synthesis_id','finding_key')) AS evidence_columns`,
      [schema],
    ),
    getNamedIndexStatus(client, schema, RESEARCH_EVIDENCE_PROMOTION_INDEXES),
  ])
  if (!rows[0]?.sources_table || rows[0]?.evidence_columns !== 2 || !indexes.indexesValid) {
    const invalid = indexes.indexes.filter(index => !index.valid).map(index => index.name).join(", ")
    throw new Error(`Migration 052 postcondition failed: research evidence promotion catalog is incomplete${invalid ? ` (${invalid})` : ""}.`)
  }
}

async function getResearchGuidedUxReport(client: PoolClient, schema: string, asyncIndexJobIds: string[] = []) {
  const indexStatus = await getNamedIndexStatus(client, schema, RESEARCH_GUIDED_UX_INDEXES)
  const asyncIndexJobs = await getAsyncIndexJobStatus(client, asyncIndexJobIds)
  return {
    preflight: {
      passed: true,
      writesExistingRows: false,
      reason: "Migration 037 adds nullable columns and new empty tables; it performs no backfill.",
    },
    ...indexStatus,
    asyncIndexJobs,
  }
}

async function getResearchBlobCleanupReport(client: PoolClient, schema: string, asyncIndexJobIds: string[] = []) {
  const indexStatus = await getNamedIndexStatus(client, schema, RESEARCH_BLOB_CLEANUP_INDEXES)
  const asyncIndexJobs = await getAsyncIndexJobStatus(client, asyncIndexJobIds)
  return {
    preflight: {
      passed: true,
      writesExistingRows: false,
      reason: "Migration 038 creates a new empty table and performs no backfill.",
    },
    ...indexStatus,
    asyncIndexJobs,
  }
}

async function getAsyncIndexJobStatus(client: PoolClient, jobIds: string[]) {
  if (jobIds.length === 0) {
    return {
      waited: false,
      jobIds,
      jobs: [] as { jobId: string; status: string; details: string | null; objectName: string | null }[],
      reason:
        "No CREATE INDEX ASYNC job IDs were created by this request. Poll this authenticated GET until indexesValid is true before enabling the feature.",
    };
  }

  const { rows } = await client.query<{
    job_id: string;
    status: string;
    details: string | null;
    object_name: string | null;
  }>(
    `SELECT job_id, status, details, object_name
     FROM sys.jobs
     WHERE job_id = ANY($1::text[])`,
    [jobIds]
  );
  const jobsById = new Map(rows.map((row) => [row.job_id, row]));
  const jobs = jobIds.map((jobId) => {
    const job = jobsById.get(jobId);
    return {
      jobId,
      status: job?.status ?? "unknown",
      details: job?.details ?? null,
      objectName: job?.object_name ?? null,
    };
  });

  return {
    waited: false,
    jobIds,
    jobs,
    reason:
      "The route has a 60-second execution limit, while an async index build may run longer. Poll this authenticated GET until indexesValid is true before enabling the feature.",
  };
}

async function getResearchCaptureHardeningReport(
  client: PoolClient,
  schema: string,
  asyncIndexJobIds: string[] = []
) {
  const [preflight, indexStatus] = await Promise.all([
    getResearchCapturePreflight(client, schema),
    getResearchCaptureIndexStatus(client, schema),
  ]);
  const asyncIndexJobs = await getAsyncIndexJobStatus(client, asyncIndexJobIds);

  return {
    preflight,
    ...indexStatus,
    asyncIndexJobs,
  };
}

// GET — check migration status
export async function getMigrationStatus(pool: Pool, schema: string) {
  const client = await pool.connect();

  try {
    // Check if tracking table exists
    const { rows } = await client.query<{ name: string; applied?: boolean }>(`
      SELECT migration_name as name, finished_at IS NOT NULL AS applied
       FROM "${schema}"._prisma_migrations
      ORDER BY started_at ASC
    `).catch(() => ({ rows: [] as { name: string; applied?: boolean }[] }));
    const appliedNames = rows.filter((row) => row.applied !== false).map((row) => row.name)
    const incompleteNames = rows.filter((row) => row.applied === false).map((row) => row.name)
    const [researchCaptureHardening, researchGuidedUx, researchBlobCleanup, researchVoiceControlPlane, decisionGateInfrastructure, decisionMigrationProgress, legacyDecisionReviewRepair] = await Promise.all([
      getResearchCaptureHardeningReport(client, schema),
      getResearchGuidedUxReport(client, schema),
      getResearchBlobCleanupReport(client, schema),
      getResearchVoiceControlPlaneReport(client, schema),
      getDecisionGateInfrastructureHealth(client, schema, appliedNames, incompleteNames),
      client.query(`SELECT migration_name, attempt_id, plan_version, plan_fingerprint, next_step, executing_step, executing_started_at, pending_step, pending_job_id, claim_epoch, claimed_by IS NOT NULL AND claim_expires_at >= CURRENT_TIMESTAMP AS claimed, last_error, updated_at FROM "${schema}"._migration_execution_state ORDER BY updated_at DESC`).then(({ rows }) => rows).catch(() => []),
      getLegacyDecisionReviewRepairStatus(pool, schema),
    ]);

    return NextResponse.json({
      schema,
      appliedMigrations: appliedNames,
      incompleteMigrations: incompleteNames,
      manifest: MIGRATIONS.map((m) => m.name),
      researchCaptureHardening,
      researchGuidedUx,
      researchBlobCleanup,
      researchVoiceControlPlane,
      decisionGateInfrastructure,
      decisionMigrationProgress,
      legacyDecisionReviewRepair,
    });
  } finally {
    client.release();

  }
}

// POST — apply a migration (or all pending)
export async function applyMigrations(pool: Pool, schema: string, targetScript?: string, options: { preProvisionedSchema?: boolean; legacyDecisionRepairManifest?: LegacyDecisionRepairManifest } = {}) {
  const client = await pool.connect();
  const log: string[] = [`Using schema: ${schema}`];
  const researchCaptureAsyncIndexJobIds: string[] = [];
  const researchGuidedUxAsyncIndexJobIds: string[] = [];
  const researchBlobCleanupAsyncIndexJobIds: string[] = [];

  try {
    // Ensure schema exists
    if (options.preProvisionedSchema) {
      const existing = await client.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name=$1", [schema]);
      if (existing.rows.length !== 1) throw new Error("Pre-provisioned schema is not accessible");
    } else {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    }

    // Ensure migration tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"._prisma_migrations (
        id               UUID    NOT NULL DEFAULT gen_random_uuid(),
        migration_name   VARCHAR(255) NOT NULL,
        started_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at      TIMESTAMP(3),
        CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id)
      )
    `);

    // Get already-applied migrations
    const { rows: applied } = await client.query<{ migration_name: string }>(
      `SELECT migration_name FROM "${schema}"._prisma_migrations WHERE finished_at IS NOT NULL`
    );
    const appliedSet = new Set(applied.map((r) => r.migration_name));

    const toRun = MIGRATIONS.filter((m) =>
      targetScript
        ? m.name === targetScript && !(appliedSet.has(m.name) || (m.name === "039_native_decision_gates" && appliedSet.has("042_native_decision_gates_repair")))
        : !(appliedSet.has(m.name) || (m.name === "039_native_decision_gates" && appliedSet.has("042_native_decision_gates_repair")))
    );

    if (toRun.length === 0) {
      const [researchCaptureHardening, researchGuidedUx, researchBlobCleanup, researchVoiceControlPlane] = await Promise.all([
        getResearchCaptureHardeningReport(client, schema),
        getResearchGuidedUxReport(client, schema),
        getResearchBlobCleanupReport(client, schema),
        getResearchVoiceControlPlaneReport(client, schema),
      ]);
      return NextResponse.json({
        message: "Nothing to apply. All migrations up to date.",
        schema,
        researchCaptureHardening,
        researchGuidedUx,
        researchBlobCleanup,
        researchVoiceControlPlane,
      });
    }

    const decisionMigration = isDecisionMigration(toRun[0].name) ? toRun[0] : undefined
    if (decisionMigration) {
      // Decision-gate migrations advance one durable step per invocation. In
      // all-pending mode no dependent migration starts until this one reaches
      // its terminal postcondition check and receives a finished receipt.
      await client.query(`SET search_path TO "${schema}"`)
      const existingState = decisionMigration.name === "042_native_decision_gates_repair"
        ? (await client.query<{ attempt_id: string }>(`SELECT attempt_id FROM "${schema}"._migration_execution_state WHERE migration_name=$1`, [decisionMigration.name]).catch(() => ({ rows: [] as { attempt_id: string }[] }))).rows[0]
        : undefined
      // Exact partial-catalog preflight is the admission gate for creating the
      // durable 042 attempt. Once admitted, the evolving catalog may contain
      // intentionally building indexes; resumes rely on fenced state/job
      // correlation and the terminal exact postconditions instead.
      const repairState = decisionMigration.name === "042_native_decision_gates_repair" && !existingState
        ? await inspectRepair039State(client, schema)
        : undefined
      const progress = await advanceDecisionMigration(client, schema, decisionMigration as { name: DecisionMigrationName; filePath: string }, log, repairState)
      return NextResponse.json({ schema, migrationProgress: progress, message: log.join("\n") }, { status: progress.status })
    }

    for (const migration of toRun) {
      log.push(`\nApplying: ${migration.name}`);
      const repair039State = migration.name === "042_native_decision_gates_repair"
        ? await inspectRepair039State(client, schema)
        : null

      if (migration.name === "036_research_capture_hardening") {
        const preflight = await getResearchCapturePreflight(client, schema);
        if (!preflight.passed) {
          const indexStatus = await getResearchCaptureIndexStatus(client, schema);
          return NextResponse.json(
            {
              error:
                "Migration 036 preflight failed Aurora DSQL's 3,000-row or 10 MiB write-transaction limit.",
              schema,
              researchCaptureHardening: {
                preflight,
                ...indexStatus,
                asyncIndexJobs: {
                  waited: false,
                  jobIds: [] as string[],
                  reason: "Migration 036 was not started, so there are no async index jobs.",
                },
              },
            },
            { status: 409 }
          );
        }
      }

      const rawSql = readFileSync(migration.filePath, "utf-8");
      const voiceCatalog = ["047_research_voice_control_plane", "049_research_participant_voice"].includes(migration.name) ? voiceMigrationCatalog(rawSql, migration.name) : undefined;
      // Admit partial 047 only when every existing object has the intended
      // definition. A previous unfinished receipt remains forensic evidence.
      const voiceExisting = voiceCatalog ? await inspectVoiceMigrationCatalog(client, schema, voiceCatalog) : undefined;
      const attemptId = randomUUID()
      await client.query(
        `INSERT INTO "${schema}"._prisma_migrations (id, migration_name) VALUES ($1, $2)`,
        [attemptId, migration.name],
      )

      // Strip all SQL line comments (-- ...) before splitting, so a leading
      // comment on a CREATE statement can't cause the whole statement to be
      // silently dropped by the startsWith("--") filter.
      const strippedSql = rawSql
        .split("\n")
        .map((line) => line.replace(/--.*$/, "").trimEnd())
        .join("\n");

      // Split on statement boundaries and run them one by one.
      const statements = strippedSql
        .split(/;\s*\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => (s.endsWith(";") ? s : `${s};`));

      // Prefix unqualified DDL with schema search_path
      await client.query(`SET search_path TO "${schema}"`);

      let pendingRoadmapCommitmentProvenanceBackfill = false;
      for (const stmt of statements) {
        try {
          const existingTable = stmt.match(/^CREATE TABLE (\w+) /)?.[1];
          const existingIndex = stmt.match(/^CREATE (?:UNIQUE )?INDEX ASYNC (\w+) /)?.[1];
          if (voiceExisting && ((existingTable && voiceExisting.tables.includes(existingTable)) || (existingIndex && voiceExisting.indexes.some((index) => index.name === existingIndex)))) {
            log.push(`  ~ verified matching ${migration.name} object already exists (skipped)`);
            continue;
          }
          // ASYNC is mandatory on DSQL and unsupported by local PostgreSQL.
          // DATABASE_URL is the worktree-bootstrap local-mode signal.
          const executableStmt = process.env.DATABASE_URL
            ? stmt.replace(/\bINDEX ASYNC\b/gi, "INDEX").replace(/ALTER\s+TABLE\s+ASYNC/gi, "ALTER TABLE")
            : stmt;
          const voiceCounterBackfill = migration.name === "047_research_voice_control_plane"
            ? RESEARCH_VOICE_COUNTER_BACKFILLS.find(({ table, column }) =>
                new RegExp(`^ALTER\\s+TABLE\\s+${table}\\s+ALTER\\s+COLUMN\\s+${column}\\s+SET\\s+DEFAULT\\s+0`, "i").test(executableStmt))
            : undefined;
          if (voiceCounterBackfill) {
            await backfillNullableResearchVoiceColumn(client, schema, voiceCounterBackfill, log);
          }
          if (repair039State?.checkPresent && /ADD\s+CONSTRAINT\s+"chk_roadmap_items_commitment_provenance_not_null"/i.test(executableStmt)) {
            log.push("  ~ matching provenance CHECK already exists (skipped)")
            continue
          }
          if (repair039State?.checkValid && /VALIDATE\s+CONSTRAINT\s+"chk_roadmap_items_commitment_provenance_not_null"/i.test(executableStmt)) {
            log.push("  ~ provenance CHECK already validated (skipped)")
            continue
          }
          const result = await client.query<{ job_id?: string }>(executableStmt);
          if (!process.env.DATABASE_URL && ASYNC_WAIT_MIGRATIONS.includes(migration.name as typeof ASYNC_WAIT_MIGRATIONS[number]) && /(?:CREATE\s+(?:UNIQUE\s+)?INDEX\s+ASYNC|ALTER\s+TABLE\s+ASYNC)/i.test(stmt)) {
            const jobId = result.rows[0]?.job_id
            // IF NOT EXISTS returns no job for an already-created agent index.
            // Its validity is checked before a completion receipt is written.
            if (!jobId && ["049_agent_identity", "050_pm_interviews", "051_pm_agent_handoff", "052_research_evidence_promotion", "053_shared_field_option_sets", "055_oauth_authorization_server", "054_webauthn_authenticators"].includes(migration.name)) continue
            if (!jobId) throw new Error(`Migration ${migration.name} async DDL returned no job_id.`)
            await client.query("CALL sys.wait_for_job($1)", [jobId])
            const waited = await client.query<{ status: string }>("SELECT status FROM sys.jobs WHERE job_id = $1", [jobId])
            if (waited.rows[0]?.status !== "completed") throw new Error(`Aurora DSQL async DDL job ${jobId} did not complete successfully.`)
          }
          if ((migration.name === "039_native_decision_gates" || migration.name === "042_native_decision_gates_repair") && /ALTER\s+COLUMN\s+"?now_commitment_provenance"?\s+SET\s+DEFAULT/i.test(executableStmt)) {
            pendingRoadmapCommitmentProvenanceBackfill = true;
          } else if ((migration.name === "039_native_decision_gates" || migration.name === "042_native_decision_gates_repair") && pendingRoadmapCommitmentProvenanceBackfill && /^COMMIT;?$/i.test(executableStmt.trim())) {
            pendingRoadmapCommitmentProvenanceBackfill = false;
            await backfillRoadmapCommitmentProvenance(client, schema, log);
          }
          if (!process.env.DATABASE_URL && /CREATE\s+(?:UNIQUE\s+)?INDEX\s+ASYNC/i.test(stmt)) {
            const jobId = result.rows[0]?.job_id;
            if (jobId && migration.name === "036_research_capture_hardening") {
              researchCaptureAsyncIndexJobIds.push(jobId);
            } else if (jobId && migration.name === "037_research_guided_ux") {
              researchGuidedUxAsyncIndexJobIds.push(jobId);
            } else if (jobId && migration.name === "038_research_blob_cleanup") {
              researchBlobCleanupAsyncIndexJobIds.push(jobId);
            }
          }
          const label = executableStmt.slice(0, 60).replace(/\s+/g, " ");
          log.push(`  ✓ ${label}…`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!voiceCatalog && msg.includes("already exists")) {
            log.push(`  ~ already exists (skipped)`);
          } else {
            log.push(`  ✗ Error: ${msg}`);
            throw e;
          }
        }
      }

      if (migration.name === LEGACY_DECISION_REVIEW_REPAIR_MIGRATION) {
        const repair = await applyLegacyDecisionReviewRepair(pool, schema, options.legacyDecisionRepairManifest)
        log.push(`  ✓ legacy review repair: ${repair.workspaceStatus === "NOT_PRESENT" ? "target workspace not present" : repair.requests.map(({ status }) => status).join(", ")}`)
      }

      await assertDecisionMigrationPostconditions(client, schema, migration.name)
      if (migration.name === "049_research_participant_voice") {
        await inspectVoiceMigrationCatalog(client, schema, voiceCatalog!, true)
      }
      if (migration.name === "047_research_voice_control_plane") {
        await inspectVoiceMigrationCatalog(client, schema, voiceCatalog!, true)
        await assertResearchVoiceControlPlanePostconditions(client, schema)
      }
      if (migration.name === "050_pm_interviews") await assertPmInterviewPostconditions(client, schema)
      if (migration.name === "051_pm_agent_handoff") {
        const indexes = await getNamedIndexStatus(client, schema, ["idx_pm_interviews_agent_conversation"])
        const columns = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM information_schema.columns WHERE table_schema=$1 AND ((table_name='pm_interviews' AND column_name='agent_conversation_id') OR (table_name='agent_conversations' AND column_name='interview_processing_json') OR (table_name='api_keys' AND column_name IN ('scope_conversation_id','scope_claim_id')))", [schema])
        if (!indexes.indexesValid || columns.rows[0]?.count !== "4") throw new Error("Migration 051 postcondition failed: interview agent handoff catalog incomplete")
      }
      if (migration.name === "049_agent_identity") await assertAgentIdentityMigration(client, schema)
      if (migration.name === "052_research_evidence_promotion") await assertResearchEvidencePromotionPostconditions(client, schema)
      if (migration.name === "053_shared_field_option_sets") await assertSharedFieldOptionSetsMigration(client, schema)
      if (migration.name === "055_oauth_authorization_server") await assertOAuthAuthorizationServerMigration(client, schema)

      // Only this distinct attempt becomes a successful receipt. A failed
      // attempt remains unfinished as forensic evidence and is never relabeled.
      await client.query(
        `UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [attemptId]
      );

      log.push(`  ✅ ${migration.name} applied`);
    }

    const researchCaptureHardening = await getResearchCaptureHardeningReport(
      client,
      schema,
      researchCaptureAsyncIndexJobIds
    );
    const researchGuidedUx = await getResearchGuidedUxReport(client, schema, researchGuidedUxAsyncIndexJobIds);
    const researchBlobCleanup = await getResearchBlobCleanupReport(client, schema, researchBlobCleanupAsyncIndexJobIds);
    const researchVoiceControlPlane = await getResearchVoiceControlPlaneReport(client, schema);
    return NextResponse.json({ message: log.join("\n"), schema, researchCaptureHardening, researchGuidedUx, researchBlobCleanup, researchVoiceControlPlane });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, log: log.join("\n"), schema }, { status: 500 });
  } finally {
    client.release();

  }
}
