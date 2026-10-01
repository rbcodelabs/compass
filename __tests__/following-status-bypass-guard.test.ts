import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { isSubjectTypeActive, followableConfig, type FollowableSubjectType } from "@/lib/followable"
import { scanStatusWrites, type StatusWriteSite } from "./helpers/status-write-scan"

/**
 * Bypass guard (ADR "Following and in-app notifications", section 2.5 and the
 * slice 2 and 3 plans). Status writes are not centralized, so "we forgot a path"
 * would otherwise be a silent gap. This test fails on ANY write that can change a
 * followable model's lifecycle state unless it either goes through
 * `captureWorkspaceMutation` (the adapter that detects the transition and emits
 * the following event) or is listed below with a reason.
 *
 * Adding a status write? Route it through captureWorkspaceMutation. If it truly
 * cannot change status, add it to NOT_A_STATUS_WRITE with the reason. If it can,
 * and its slice has not shipped, it belongs in PENDING_SLICE_3 until that slice
 * wires it, at which point the "pending but active" assertion forces you to
 * delete the entry.
 */

type Allow = { site: string; count: number; reason: string }
const key = (site: Pick<StatusWriteSite, "file" | "model" | "operation">) => `${site.file}::${site.model}.${site.operation}`

/** Reads as a status write to a static scan but cannot change status. */
const NOT_A_STATUS_WRITE: Allow[] = [
  { site: "lib/opportunity-tool-handlers.ts::opportunity.update", count: 1, reason: "update_opportunity data is limited to title, description, customerSegment" },
  { site: "lib/solution-tool-handlers.ts::solution.update", count: 1, reason: "update_solution data is limited to title and description" },
  { site: "lib/pm-interview-service.ts::opportunity.update", count: 1, reason: "PM_INTERVIEW_ALLOWED_FIELDS contains no status field" },
  { site: "lib/pm-interview-service.ts::solution.update", count: 1, reason: "PM_INTERVIEW_ALLOWED_FIELDS contains no status field" },
  { site: "lib/pm-interview-service.ts::assumption.update", count: 1, reason: "PM_INTERVIEW_ALLOWED_FIELDS contains no status field" },
  { site: "lib/pm-interview-service.ts::experiment.update", count: 1, reason: "PM_INTERVIEW_ALLOWED_FIELDS contains no status field" },
]

/**
 * Real status writes that slice 3 will wire (ADR 7: "Tighten the guard test to
 * fail on any unlisted status write for a followable model"). Each is silent
 * today because its subject type is gated off by the registry slice.
 */
const PENDING_SLICE_3: Array<Allow & { subjectType: FollowableSubjectType }> = [
  { site: "app/[orgSlug]/[workspaceSlug]/experiments/actions.ts::experiment.update", count: 1, subjectType: "EXPERIMENT", reason: "conclude experiment transaction" },
  { site: "app/[orgSlug]/[workspaceSlug]/experiments/actions.ts::assumption.update", count: 1, subjectType: "ASSUMPTION", reason: "assumption status set when an experiment concludes" },
  { site: "app/[orgSlug]/[workspaceSlug]/feedback/actions.ts::feedbackItem.updateMany", count: 1, subjectType: "FEEDBACK_ITEM", reason: "feedback triage" },
  { site: "app/[orgSlug]/[workspaceSlug]/okrs/actions.ts::objective.update", count: 1, subjectType: "OBJECTIVE", reason: "objective status" },
  { site: "app/api/mcp/route.ts::objective.update", count: 1, subjectType: "OBJECTIVE", reason: "update_objective via the generic object tool" },
  { site: "lib/okr-tool-handlers.ts::objective.update", count: 1, subjectType: "OBJECTIVE", reason: "objective status" },
  { site: "lib/analytics/service.ts::metricDefinition.updateMany", count: 2, subjectType: "METRIC", reason: "metric archive and dashboard edits" },
  { site: "lib/analytics/service.ts::experiment.updateMany", count: 1, subjectType: "EXPERIMENT", reason: "metric binding fence (updatedAt only today, data not statically readable)" },
  { site: "lib/analytics/service.ts::roadmapItem.updateMany", count: 1, subjectType: "ROADMAP_ITEM", reason: "metric binding fence (updatedAt only today, data not statically readable)" },
  { site: "lib/artifacts.ts::artifact.update", count: 4, subjectType: "ARTIFACT", reason: "artifacts are deferred (ADR open question 3)" },
  { site: "lib/assumption-tool-handlers.ts::assumption.update", count: 1, subjectType: "ASSUMPTION", reason: "assumption status MCP tool, mutate also used without the adapter when status is absent" },
  { site: "lib/decision-service.ts::reviewRequest.update", count: 2, subjectType: "REVIEW_REQUEST", reason: "tracked decision state" },
  { site: "lib/experiment-update-tool.ts::experiment.update", count: 1, subjectType: "EXPERIMENT", reason: "update_experiment while DESIGNING" },
  { site: "lib/feedback-tool-handlers.ts::feedbackItem.update", count: 3, subjectType: "FEEDBACK_ITEM", reason: "feedback triage tools" },
  { site: "lib/release-authorization.ts::reviewRequest.update", count: 2, subjectType: "REVIEW_REQUEST", reason: "release authorization is not a tracked decision; confirm in slice 3" },
  { site: "lib/research-study-service.ts::researchStudy.update", count: 1, subjectType: "RESEARCH_STUDY", reason: "research study lifecycle" },
  { site: "lib/research-study-service.ts::researchStudy.updateMany", count: 2, subjectType: "RESEARCH_STUDY", reason: "research study lifecycle" },
  { site: "lib/tracked-decisions.ts::reviewRequest.update", count: 1, subjectType: "REVIEW_REQUEST", reason: "tracked decision state" },
  { site: "lib/tracked-decisions.ts::reviewRequest.updateMany", count: 1, subjectType: "REVIEW_REQUEST", reason: "tracked decision state" },
]

const root = process.cwd()
const sites = scanStatusWrites(root)
const direct = sites.filter((site) => !site.viaAdapter)

function countBy(list: StatusWriteSite[]) {
  const counts = new Map<string, number>()
  for (const site of list) counts.set(key(site), (counts.get(key(site)) ?? 0) + 1)
  return counts
}

describe("status-write bypass guard", () => {
  it("scans a meaningful number of sites (a broken scanner must not pass silently)", () => {
    expect(sites.length).toBeGreaterThan(40)
    expect(sites.filter((s) => s.viaAdapter).length).toBeGreaterThan(20)
  })

  it("fails on any status write that is neither adapter-wrapped nor listed", () => {
    const listed = new Set([...NOT_A_STATUS_WRITE, ...PENDING_SLICE_3].map((entry) => entry.site))
    const unlisted = direct.filter((site) => !listed.has(key(site)))
    expect(unlisted.map((s) => `${s.file}:${s.line} ${s.model}.${s.operation}`)).toEqual([])
  })

  it("keeps the allowlist exact: no stale entries, and no extra status write hiding behind a listed file", () => {
    const counts = countBy(direct)
    const mismatches = [...NOT_A_STATUS_WRITE, ...PENDING_SLICE_3]
      .filter((entry) => (counts.get(entry.site) ?? 0) !== entry.count)
      .map((entry) => `${entry.site}: expected ${entry.count}, found ${counts.get(entry.site) ?? 0}`)
    expect(mismatches).toEqual([])
  })

  it("does not let a write be pending for a subject type that has already shipped", () => {
    const shipped = PENDING_SLICE_3.filter((entry) => isSubjectTypeActive(entry.subjectType)).map((entry) => `${entry.site} (${entry.subjectType})`)
    expect(shipped, `slice ${followableConfig.shippedSlice} shipped these types; wire the sites through captureWorkspaceMutation and delete the entries`).toEqual([])
  })

  it("has no unwired status write on the slice 2 types: Task, Opportunity, Solution", () => {
    const slice2Models = new Set(["task", "opportunity", "solution"])
    const unwired = direct.filter((site) => slice2Models.has(site.model) && !NOT_A_STATUS_WRITE.some((entry) => entry.site === key(site)))
    expect(unwired.map((s) => `${s.file}:${s.line}`)).toEqual([])
  })
})

describe("scanner", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bypass-scan-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(path.join(dir, "lib"), { recursive: true })
  writeFileSync(path.join(dir, "lib", "sample.ts"), `
    export async function a(tx: any) { await tx.task.update({ where: { id }, data: { status: "DONE", updatedAt: now } }) }
    export async function b(tx: any, data: any) { await tx.task.update({ where: { id }, data }) }
    export async function c(tx: any) { await tx.task.update({ where: { id }, data: { title: "x", sortOrder: 1 } }) }
    export async function d(prisma: any) { await captureWorkspaceMutation(prisma, "task", "update", "UI", id, tx => tx.task.update({ where: { id }, data: { status: "DONE" } })) }
    export async function e(tx: any) { await tx.reviewRequest.updateMany({ where: { id }, data: { state: "DECIDED" } }) }
    export async function f(tx: any, rest: any) { await tx.solution.update({ where: { id }, data: { ...rest } }) }
    export async function g(tx: any) { await tx.task.create({ data: { status: "TODO" } }) }
    export async function h(tx: any) { await tx.widget.update({ where: { id }, data: { status: "x" } }) }
  `)

  it("flags literal and dynamic status writes, ignores creates, other models and non-status literals, and recognizes the adapter", () => {
    const found = scanStatusWrites(dir).map((s) => `${s.model}.${s.operation}:${s.evidence}:${s.viaAdapter ? "adapter" : "direct"}`)
    expect(found).toEqual([
      "task.update:literal:direct",
      "task.update:dynamic:direct",
      "task.update:literal:adapter",
      "reviewRequest.updateMany:literal:direct",
      "solution.update:dynamic:direct",
    ])
  })
})
