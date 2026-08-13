// MCP_API_KEY — set in Vercel project settings and .env.local.
// All MCP requests require:  Authorization: Bearer <MCP_API_KEY>
//
// Endpoint: POST /api/mcp  (Streamable HTTP transport)

import { createMcpHandler } from "mcp-handler"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import getPrisma from "@/lib/db"
import { validateMcpAuth } from "@/lib/mcp-auth"
import { runWithMcpActor, getMcpActor, isServiceActor } from "@/lib/mcp-authz"
import { applyToolGate } from "@/lib/mcp-tool-gates"
import {
  getFeedbackItem,
  updateFeedbackStatus,
  linkFeedbackToOpportunity,
  updateFeedbackType,
  promoteFeedbackToRoadmap,
} from "@/lib/feedback-tool-handlers"
import {
  addEvidence,
  linkEvidence,
  listEvidence,
} from "@/lib/evidence-tool-handlers"
import {
  listDocs,
  getDoc,
  createDoc,
  updateDoc,
} from "@/lib/doc-tool-handlers"
import {
  createDocVersion,
  listDocVersions,
  getDocVersion,
  restoreDocVersion,
} from "@/lib/doc-version-tool-handlers"
import {
  updateAssumption,
  deleteAssumption,
} from "@/lib/assumption-tool-handlers"
import {
  addSolutionPlan,
  addSolutionComment,
  listSolutionComments,
  getSolutionComment,
  updateSolutionComment,
  deleteSolutionComment,
  approveSolutionPlan,
  rejectSolutionPlan,
} from "@/lib/solution-comment-tool-handlers"
import {
  listScoringModels,
  getScoringModel,
  createScoringModel,
  updateScoringModel,
  archiveScoringModel,
  getWorkspaceScoringModel,
  setWorkspaceScoringModel,
  scoreOpportunity,
  getOpportunityScore,
  listTopOpportunities,
} from "@/lib/scoring-tool-handlers"
import {
  createChecklistTemplate,
  listChecklistTemplates,
  setLaunchTier,
  getLaunchChecklist,
  updateLaunchChecklistItem,
} from "@/lib/roadmap-tool-handlers"
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  moveTaskStatus,
  linkTask,
  unlinkTask,
  listTaskLinks,
} from "@/lib/task-tool-handlers"
import {
  createSquad,
  getSquad,
  listSquads,
  updateSquad,
} from "@/lib/squad-tool-handlers"
import {
  searchHelp,
  getHelp,
} from "@/lib/help-tool-handlers"
import {
  getEligibleParentKeyResults,
  setObjectiveParentKeyResult,
} from "@/lib/okr-hierarchy"
import { listEligibleParentKeyResults } from "@/lib/okr-tool-handlers"

// Roadmap item start/end dates come from a plain "YYYY-MM-DD" string (an
// <input type="date"> value, or an MCP caller's ISO date string), which
// `new Date(...)` parses as UTC midnight. Formatting with `toLocaleDateString()`
// (local timezone) would shift the displayed date back a day for any negative
// UTC offset, so format in UTC to match how the date was parsed.
function formatUtcDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(date)
}

const _handler = createMcpHandler(
  (server) => {

    // Register every tool THROUGH this wrapper so its authorization gate
    // (lib/mcp-tool-gates.ts) runs before the handler. Fail-closed: a tool
    // with no gate entry is denied by applyToolGate. The acting identity is
    // read from AsyncLocalStorage (set by withMcpAuth). `any` here: the SDK's
    // registerTool has many generic overloads we don't need to reproduce, and
    // args are validated by each tool's zod inputSchema before the gate runs.
    const register = (
      name: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      meta: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: (args: any, extra?: any) => any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) => (server.registerTool as (...a: any[]) => any)(name, meta, async (args: any, extra: any) => {
      await applyToolGate(name, getMcpActor(), args ?? {})
      return handler(args, extra)
    })

    // ════════════════════════════════════════════════════════════════
    // WORKSPACE
    // ════════════════════════════════════════════════════════════════

    register(
      "get_workspace_summary",
      {
        title: "Get Workspace Summary",
        description:
          "Returns high-level counts and status for a workspace: name, OKR cycles, " +
          "opportunities, experiments, roadmap items, active experiments, active OKR cycle, and squads.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
        },
      },
      async ({ workspaceId }) => {
        const prisma = getPrisma()
        const [workspace, okrCycleCount, opportunityCount, experimentCount, roadmapItemCount, activeExperiments, activeOKRCycle, squads] =
          await Promise.all([
            prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
            prisma.oKRCycle.count({ where: { workspaceId } }),
            prisma.opportunity.count({ where: { workspaceId, NOT: { status: "ARCHIVED" } } }),
            prisma.experiment.count({ where: { workspaceId } }),
            prisma.roadmapItem.count({ where: { workspaceId, status: "ACTIVE" } }),
            prisma.experiment.count({ where: { workspaceId, status: "RUNNING" } }),
            prisma.oKRCycle.findFirst({
              where: { workspaceId, status: "ACTIVE" },
              select: { id: true, title: true, startDate: true, endDate: true },
            }),
            prisma.squad.findMany({ where: { workspaceId }, select: { id: true, name: true, color: true }, orderBy: { createdAt: "asc" } }),
          ])

        if (!workspace) {
          return { content: [{ type: "text" as const, text: `No workspace found with id "${workspaceId}".` }] }
        }

        const cycleText = activeOKRCycle
          ? `${activeOKRCycle.title} (${activeOKRCycle.startDate.toLocaleDateString()} – ${activeOKRCycle.endDate.toLocaleDateString()}) — ID: ${activeOKRCycle.id}`
          : "None"
        const squadText = squads.length ? squads.map(s => `${s.name} (${s.id})`).join(", ") : "None"

        return {
          content: [{
            type: "text" as const,
            text:
              `**Workspace:** ${workspace.name}\n\n` +
              `**Active OKR Cycle:** ${cycleText}\n` +
              `**Opportunities (active):** ${opportunityCount}\n` +
              `**Experiments:** ${experimentCount} (${activeExperiments} running)\n` +
              `**Roadmap Items (active):** ${roadmapItemCount}\n` +
              `**OKR Cycles total:** ${okrCycleCount}\n` +
              `**Squads:** ${squadText}`,
          }],
        }
      }
    )

    // ----------------------------------------------------------------
    // list_workspaces — entry-point for agents discovering workspace IDs
    // ----------------------------------------------------------------
    register(
      "list_workspaces",
      {
        title: "List Workspaces",
        description:
          "Lists all workspaces in an organization by org slug. " +
          "Use this as the FIRST CALL when you don't yet know a workspace ID. " +
          "Returns workspace IDs, names, slugs, and brief stats.",
        inputSchema: {
          orgSlug: z.string().min(1).describe("The organization slug (e.g. 'rbcodelabs')"),
        },
      },
      async ({ orgSlug }) => {
        const actor = getMcpActor()
        const prisma = getPrisma()
        // Scope returned workspaces to the caller's memberships (service key
        // sees all). The gate already asserted org membership.
        const workspaceFilter = isServiceActor(actor)
          ? {}
          : { members: { some: { userId: actor.userId! } } }
        const org = await prisma.organization.findUnique({
          where: { slug: orgSlug },
          select: {
            id: true,
            name: true,
            workspaces: {
              where: workspaceFilter,
              select: {
                id: true,
                slug: true,
                name: true,
                description: true,
                _count: {
                  select: {
                    opportunities: true,
                    experiments: true,
                    roadmapItems: true,
                    okrCycles: true,
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        })
        if (!org) {
          return { content: [{ type: "text" as const, text: `No organization found with slug "${orgSlug}".` }] }
        }
        if (!org.workspaces.length) {
          return { content: [{ type: "text" as const, text: `Organization "${org.name}" has no workspaces yet.` }] }
        }
        const lines = org.workspaces.map(w =>
          `• **${w.name}** (/${orgSlug}/${w.slug})\n` +
          `  ID: ${w.id}\n` +
          (w.description ? `  ${w.description}\n` : "") +
          `  ${w._count.opportunities} opportunities · ${w._count.experiments} experiments · ` +
          `${w._count.roadmapItems} roadmap items · ${w._count.okrCycles} OKR cycles`
        )
        return {
          content: [{
            type: "text" as const,
            text: `**${org.name}** — ${org.workspaces.length} workspace(s)\n\n` + lines.join("\n\n"),
          }],
        }
      }
    )

    // ----------------------------------------------------------------
    // get_workspace_by_slug — resolves a workspace ID directly from
    // org slug + workspace slug, without listing all workspaces first
    // ----------------------------------------------------------------
    register(
      "get_workspace_by_slug",
      {
        title: "Get Workspace By Slug",
        description:
          "Looks up a single workspace by org slug + workspace slug and returns its ID, name, " +
          "slug, and description. Use this instead of list_workspaces when you already know both " +
          "slugs (e.g. from a URL like /org-slug/workspace-slug) and just need the workspace ID.",
        inputSchema: {
          orgSlug: z.string().min(1).describe("The organization slug (e.g. 'rbcodelabs')"),
          workspaceSlug: z.string().min(1).describe("The workspace slug (e.g. 'compass')"),
        },
      },
      async ({ orgSlug, workspaceSlug }) => {
        const prisma = getPrisma()
        const org = await prisma.organization.findUnique({
          where: { slug: orgSlug },
          select: { id: true, name: true },
        })
        if (!org) {
          return { content: [{ type: "text" as const, text: `No organization found with slug "${orgSlug}".` }] }
        }
        const workspace = await prisma.workspace.findFirst({
          where: { organizationId: org.id, slug: workspaceSlug },
          select: { id: true, name: true, slug: true, description: true },
        })
        if (!workspace) {
          return { content: [{ type: "text" as const, text: `No workspace found with slug "${workspaceSlug}" in organization "${org.name}".` }] }
        }
        return {
          content: [{
            type: "text" as const,
            text:
              `**Workspace:** ${workspace.name}\n` +
              `ID: ${workspace.id}\n` +
              `Slug: ${workspace.slug}\n` +
              (workspace.description ? `${workspace.description}\n` : "") +
              `URL: /${orgSlug}/${workspace.slug}`,
          }],
        }
      }
    )

    // ----------------------------------------------------------------
    // create_workspace — creates a new workspace inside an organization
    // ----------------------------------------------------------------
    register(
      "create_workspace",
      {
        title: "Create Workspace",
        description: "Creates a new workspace inside an organization. Returns the workspace ID, name, and URL slug.",
        inputSchema: {
          orgSlug: z.string().min(1).describe("The organization slug (e.g. 'rbcodelabs')"),
          name: z.string().min(1).describe("Human-readable workspace name"),
          slug: z
            .string()
            .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens only")
            .describe("URL slug for the workspace (lowercase, alphanumeric + hyphens)"),
          description: z.string().optional().describe("Short description of the workspace"),
        },
      },
      async ({ orgSlug, name, slug, description }) => {
        const prisma = getPrisma()
        const org = await prisma.organization.findUnique({
          where: { slug: orgSlug },
          select: { id: true, name: true },
        })
        if (!org) {
          return { content: [{ type: "text" as const, text: `No organization found with slug "${orgSlug}".` }] }
        }
        const existing = await prisma.workspace.findFirst({
          where: { organizationId: org.id, slug },
          select: { id: true },
        })
        if (existing) {
          return { content: [{ type: "text" as const, text: `A workspace with slug "${slug}" already exists in organization "${org.name}".` }] }
        }
        const workspace = await prisma.workspace.create({
          data: {
            organizationId: org.id,
            name: name.trim(),
            slug,
            description: description?.trim(),
          },
        })

        // Add all org members as workspace members so the workspace is
        // immediately accessible in the UI. Without this, getWorkspace()
        // filters by membership and returns null → 404.
        const orgMembers = await prisma.organizationMember.findMany({
          where: { organizationId: org.id },
          select: { userId: true, role: true },
        })
        if (orgMembers.length > 0) {
          await prisma.workspaceMember.createMany({
            data: orgMembers.map((m) => ({
              workspaceId: workspace.id,
              userId: m.userId,
              role: m.role,
            })),
            skipDuplicates: true,
          })
        }

        // This mutation happens via the MCP route (a plain Prisma write, not
        // a Server Action), so none of Next's automatic revalidation kicks
        // in. Without this, /dashboard and the workspace sidebar switcher
        // keep serving the stale pre-creation payload from the client-side
        // router cache on a soft nav — the workspace exists in the DB but
        // looks missing until a hard reload. There's no single concrete
        // per-workspace-slug path to target yet (the workspace is brand
        // new), so revalidate /dashboard directly plus the root layout to
        // cover the sidebar switcher on whichever workspace the browsing
        // user currently has open.
        revalidatePath("/dashboard")
        revalidatePath("/", "layout")

        return {
          content: [{
            type: "text" as const,
            text:
              `**Workspace created**\n` +
              `ID: ${workspace.id}\n` +
              `Name: ${workspace.name}\n` +
              `Slug: ${workspace.slug}\n` +
              `URL: /${orgSlug}/${workspace.slug}`,
          }],
        }
      }
    )

    // ════════════════════════════════════════════════════════════════
    // OKRs
    // ════════════════════════════════════════════════════════════════

    register(
      "list_okr_cycles",
      {
        title: "List OKR Cycles",
        description: "Lists all OKR cycles for a workspace with their IDs, titles, dates, and status.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
        },
      },
      async ({ workspaceId }) => {
        const prisma = getPrisma()
        const cycles = await prisma.oKRCycle.findMany({
          where: { workspaceId },
          orderBy: { startDate: "desc" },
          select: { id: true, title: true, status: true, startDate: true, endDate: true, _count: { select: { objectives: true } } },
        })
        if (!cycles.length) {
          return { content: [{ type: "text" as const, text: "No OKR cycles found for this workspace." }] }
        }
        const lines = cycles.map(c =>
          `• **${c.title}** [${c.status}] ${c.startDate.toLocaleDateString()} – ${c.endDate.toLocaleDateString()} — ${c._count.objectives} objectives — ID: ${c.id}`
        )
        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      }
    )

    register(
      "create_okr_cycle",
      {
        title: "Create OKR Cycle",
        description: "Creates a new OKR cycle for a workspace. Status defaults to DRAFT; set status to ACTIVE to make it the live cycle.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          title: z.string().min(1).describe("Cycle title, e.g. 'Q3 2026'"),
          startDate: z.string().describe("ISO date string for cycle start, e.g. '2026-07-01'"),
          endDate: z.string().describe("ISO date string for cycle end, e.g. '2026-09-30'"),
          status: z.enum(["DRAFT", "ACTIVE", "COMPLETED"]).optional().describe("Cycle status (default: ACTIVE)"),
        },
      },
      async ({ workspaceId, title, startDate, endDate, status }) => {
        const prisma = getPrisma()
        const cycle = await prisma.oKRCycle.create({
          data: {
            workspaceId,
            title,
            startDate: new Date(startDate),
            endDate: new Date(endDate),
            status: status ?? "ACTIVE",
          },
        })
        return {
          content: [{
            type: "text" as const,
            text: `OKR cycle created: **${cycle.title}** [${cycle.status}]\n${cycle.startDate.toLocaleDateString()} – ${cycle.endDate.toLocaleDateString()}\nCycle ID: ${cycle.id}`,
          }],
        }
      }
    )

    register(
      "get_okr_cycle",
      {
        title: "Get OKR Cycle",
        description: "Returns a full OKR cycle with all objectives and their key results including current progress.",
        inputSchema: {
          cycleId: z.string().uuid().describe("UUID of the OKR cycle"),
        },
      },
      async ({ cycleId }) => {
        const prisma = getPrisma()
        const cycle = await prisma.oKRCycle.findUnique({
          where: { id: cycleId },
          include: {
            objectives: {
              orderBy: { createdAt: "asc" },
              include: {
                keyResults: {
                  orderBy: { createdAt: "asc" },
                  include: {
                    supportingObjectives: {
                      select: {
                        id: true,
                        title: true,
                        status: true,
                        cycle: { select: { id: true, title: true } },
                      },
                      orderBy: [{ cycle: { startDate: "asc" } }, { createdAt: "asc" }],
                    },
                  },
                },
                squad: { select: { name: true } },
                parentKeyResult: {
                  select: {
                    id: true,
                    title: true,
                    objective: {
                      select: { title: true, cycle: { select: { title: true } } },
                    },
                  },
                },
              },
            },
          },
        })
        if (!cycle) {
          return { content: [{ type: "text" as const, text: `OKR cycle "${cycleId}" not found.` }] }
        }

        const lines: string[] = [
          `**${cycle.title}** (${cycle.status})`,
          `${cycle.startDate.toLocaleDateString()} – ${cycle.endDate.toLocaleDateString()}`,
          `Cycle ID: ${cycle.id}`,
          "",
        ]
        for (const obj of cycle.objectives) {
          const avg = obj.keyResults.length
            ? Math.round(obj.keyResults.reduce((s, kr) => s + (kr.target > 0 ? Math.min(100, (kr.current / kr.target) * 100) : 0), 0) / obj.keyResults.length)
            : 0
          lines.push(`## ${obj.title} [${obj.status}] ${obj.squad ? `(${obj.squad.name})` : ""}  — ${avg}%`)
          lines.push(`Objective ID: ${obj.id}`)
          if (obj.parentKeyResult) {
            lines.push(
              `Supports: ${obj.parentKeyResult.objective.cycle.title} / ${obj.parentKeyResult.objective.title} / ${obj.parentKeyResult.title} (${obj.parentKeyResult.id})`
            )
          }
          for (const kr of obj.keyResults) {
            const pct = kr.target > 0 ? ((kr.current / kr.target) * 100).toFixed(0) : "—"
            lines.push(`  • ${kr.title}: ${kr.current}/${kr.target}${kr.unit ? " " + kr.unit : ""} (${pct}%) — KR ID: ${kr.id}`)
            for (const supporting of kr.supportingObjectives) {
              lines.push(`    ↳ ${supporting.cycle.title} / ${supporting.title} [${supporting.status}] — Objective ID: ${supporting.id}`)
            }
          }
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      }
    )

    register(
      "create_objective",
      {
        title: "Create Objective",
        description: "Creates a new Objective inside an OKR cycle. Optionally assign a squad or link it to a higher-level KR from a longer cycle.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          cycleId: z.string().uuid().describe("UUID of the OKR cycle"),
          title: z.string().min(1).describe("Short title for the objective"),
          description: z.string().optional().describe("Longer description"),
          owner: z.string().optional().describe("Name or email of the accountable owner"),
          squadId: z.string().uuid().optional().describe("UUID of the squad this objective belongs to"),
          parentKeyResultId: z.string().uuid().optional().describe("UUID of a higher-level KR from a longer cycle in the same workspace"),
        },
      },
      async ({ workspaceId, cycleId, title, description, owner, squadId, parentKeyResultId }) => {
        const prisma = getPrisma()
        const cycle = await prisma.oKRCycle.findFirst({ where: { id: cycleId, workspaceId }, select: { id: true, title: true } })
        if (!cycle) {
          return { content: [{ type: "text" as const, text: `OKR cycle "${cycleId}" not found in workspace.` }] }
        }
        if (parentKeyResultId) {
          const eligible = await getEligibleParentKeyResults(workspaceId, cycleId)
          if (!eligible.some((kr) => kr.id === parentKeyResultId)) {
            return { content: [{ type: "text" as const, text: "The parent KR must be in an open, longer-horizon cycle that contains this cycle." }] }
          }
        }
        const objective = await prisma.objective.create({
          data: { cycleId, title: title.trim(), description: description?.trim(), owner: owner?.trim(), squadId: squadId ?? null, parentKeyResultId: parentKeyResultId ?? null },
        })
        return {
          content: [{
            type: "text" as const,
            text: `**Objective created** in cycle "${cycle.title}"\nID: ${objective.id}\nTitle: ${objective.title}\nStatus: ${objective.status}`,
          }],
        }
      }
    )

    register(
      "add_key_result",
      {
        title: "Add Key Result",
        description: "Adds a Key Result to an existing Objective.",
        inputSchema: {
          objectiveId: z.string().uuid().describe("UUID of the parent objective"),
          title: z.string().min(1).describe("What will be measured"),
          target: z.number().describe("Numeric target value"),
          unit: z.string().optional().describe("Unit label, e.g. '%', 'users', 'NPS'"),
        },
      },
      async ({ objectiveId, title, target, unit }) => {
        const prisma = getPrisma()
        const objective = await prisma.objective.findUnique({ where: { id: objectiveId }, select: { id: true, title: true } })
        if (!objective) {
          return { content: [{ type: "text" as const, text: `Objective "${objectiveId}" not found.` }] }
        }
        const keyResult = await prisma.keyResult.create({
          data: { objectiveId, title: title.trim(), target, unit: unit?.trim() },
        })
        return {
          content: [{
            type: "text" as const,
            text: `**Key Result created** on "${objective.title}"\nID: ${keyResult.id}\nTitle: ${keyResult.title}\nTarget: ${keyResult.target}${keyResult.unit ? " " + keyResult.unit : ""}\nCurrent: 0`,
          }],
        }
      }
    )

    register(
      "log_checkin",
      {
        title: "Log Check-In",
        description: "Records a progress check-in for a Key Result and updates its current value.",
        inputSchema: {
          keyResultId: z.string().uuid().describe("UUID of the key result"),
          value: z.number().describe("New current value"),
          note: z.string().optional().describe("Context note about this check-in"),
        },
      },
      async ({ keyResultId, value, note }) => {
        const prisma = getPrisma()
        const existing = await prisma.keyResult.findUnique({ where: { id: keyResultId }, select: { id: true, title: true, target: true, unit: true } })
        if (!existing) {
          return { content: [{ type: "text" as const, text: `Key Result "${keyResultId}" not found.` }] }
        }
        await Promise.all([
          prisma.checkIn.create({ data: { keyResultId, value, note: note?.trim() } }),
          prisma.keyResult.update({ where: { id: keyResultId }, data: { current: value } }),
        ])
        const pct = existing.target > 0 ? ((value / existing.target) * 100).toFixed(1) : "N/A"
        return {
          content: [{
            type: "text" as const,
            text: `**Check-in logged** for "${existing.title}"\nCurrent: ${value}${existing.unit ? " " + existing.unit : ""} / ${existing.target} (${pct}%)` + (note ? `\nNote: ${note}` : ""),
          }],
        }
      }
    )

    register(
      "list_eligible_parent_key_results",
      {
        title: "List Eligible Parent Key Results",
        description: "Lists KRs in open, longer-horizon cycles that can be supported by Objectives in a specified child cycle.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          cycleId: z.string().uuid().describe("UUID of the child OKR cycle"),
        },
      },
      listEligibleParentKeyResults
    )

    register(
      "set_objective_parent_kr",
      {
        title: "Set Objective Parent KR",
        description: "Links an Objective to a higher-level Key Result it supports. Pass null keyResultId to clear the link.",
        inputSchema: {
          objectiveId: z.string().uuid().describe("UUID of the objective"),
          keyResultId: z.string().uuid().nullable().describe("UUID of the company KR to support, or null to clear"),
        },
      },
      async ({ objectiveId, keyResultId }) => {
        const prisma = getPrisma()
        const objective = await prisma.objective.findUnique({
          where: { id: objectiveId },
          select: { cycle: { select: { workspaceId: true } } },
        })
        if (!objective) {
          return { content: [{ type: "text" as const, text: `Objective "${objectiveId}" not found.` }] }
        }
        try {
          await setObjectiveParentKeyResult({
            workspaceId: objective.cycle.workspaceId,
            objectiveId,
            keyResultId,
          })
        } catch (error) {
          return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Could not update OKR hierarchy." }] }
        }
        return {
          content: [{
            type: "text" as const,
            text: keyResultId
              ? `Objective ${objectiveId} now supports KR ${keyResultId}.`
              : `Cleared parent KR from objective ${objectiveId}.`,
          }],
        }
      }
    )

    // ════════════════════════════════════════════════════════════════
    // DISCOVERY — Opportunities, Solutions, Assumptions
    // ════════════════════════════════════════════════════════════════

    register(
      "list_opportunities",
      {
        title: "List Opportunities",
        description: "Lists opportunities in a workspace, with optional filters by status and squad.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          status: z.enum(["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "ARCHIVED"]).optional().describe("Filter by status"),
          squadId: z.string().uuid().optional().describe("Filter by squad"),
        },
      },
      async ({ workspaceId, status, squadId }) => {
        const prisma = getPrisma()
        const opportunities = await prisma.opportunity.findMany({
          where: { workspaceId, ...(status ? { status } : {}), ...(squadId ? { squadId } : {}) },
          include: {
            linkedKeyResult: { select: { title: true, objective: { select: { title: true } } } },
            squad: { select: { name: true } },
            _count: { select: { solutions: true } },
          },
          orderBy: { createdAt: "desc" },
        })
        if (!opportunities.length) {
          return { content: [{ type: "text" as const, text: "No opportunities found." }] }
        }
        const lines = opportunities.map(o =>
          `• **${o.title}** [${o.status}]${o.squad ? ` (${o.squad.name})` : ""} — ${o._count.solutions} solutions` +
          (o.linkedKeyResult ? ` — KR: ${o.linkedKeyResult.objective.title} / ${o.linkedKeyResult.title}` : "") +
          `\n  ID: ${o.id}`
        )
        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      }
    )

    register(
      "get_opportunity",
      {
        title: "Get Opportunity",
        description: "Returns full detail for an opportunity: solutions, assumptions per solution, and experiments linked to those assumptions.",
        inputSchema: {
          opportunityId: z.string().uuid().describe("UUID of the opportunity"),
        },
      },
      async ({ opportunityId }) => {
        const prisma = getPrisma()
        const opp = await prisma.opportunity.findUnique({
          where: { id: opportunityId },
          include: {
            linkedKeyResult: { select: { id: true, title: true, objective: { select: { title: true } } } },
            squad: { select: { name: true } },
            solutions: {
              orderBy: { createdAt: "asc" },
              include: {
                assumptions: {
                  orderBy: { createdAt: "asc" },
                  include: { experiments: { select: { id: true, title: true, status: true, conclusion: true }, orderBy: { createdAt: "desc" } } },
                },
                // Only the latest PLAN entry is needed here — the full thread
                // is fetched separately via list_solution_comments, to avoid
                // bloating this nested-tree payload.
                comments: {
                  where: { commentType: "PLAN" },
                  orderBy: { createdAt: "desc" },
                  take: 1,
                },
                _count: { select: { comments: true } },
              },
            },
          },
        })
        if (!opp) {
          return { content: [{ type: "text" as const, text: `Opportunity "${opportunityId}" not found.` }] }
        }

        const lines: string[] = [
          `# ${opp.title} [${opp.status}]`,
          `ID: ${opp.id}`,
          opp.squad ? `Squad: ${opp.squad.name}` : "",
          opp.linkedKeyResult ? `Linked KR: ${opp.linkedKeyResult.objective.title} / ${opp.linkedKeyResult.title} (${opp.linkedKeyResult.id})` : "",
          opp.description ? `\n${opp.description}` : "",
          "",
        ].filter(Boolean)

        for (const sol of opp.solutions) {
          lines.push(`## Solution: ${sol.title} [${sol.status}]  — ID: ${sol.id}`)
          const latestPlan = sol.comments[0]
          const commentCount = sol._count.comments
          if (latestPlan) {
            const truncated = latestPlan.body.length > 120 ? `${latestPlan.body.slice(0, 120)}...` : latestPlan.body
            lines.push(`  Plan: ${truncated} (updated ${formatUtcDate(latestPlan.updatedAt)}) · ${commentCount} comments`)
          } else if (commentCount > 0) {
            lines.push(`  ${commentCount} comments`)
          }
          for (const a of sol.assumptions) {
            lines.push(`  Assumption [${a.status}/${a.riskLevel}]: ${a.title}  — ID: ${a.id}`)
            for (const e of a.experiments) {
              lines.push(`    Experiment [${e.status}${e.conclusion ? "/" + e.conclusion : ""}]: ${e.title}  — ID: ${e.id}`)
            }
          }
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      }
    )

    register(
      "create_opportunity",
      {
        title: "Create Opportunity",
        description: "Creates a new customer or product Opportunity. Optionally link to a Key Result and assign to a squad.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          title: z.string().min(1).describe("Short title for the opportunity"),
          description: z.string().optional().describe("What problem or need this represents"),
          customerSegment: z.string().optional().describe("The customer segment affected"),
          status: z.enum(["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE"]).optional().default("EXPLORING"),
          keyResultId: z.string().uuid().optional().describe("UUID of a Key Result this opportunity is driving"),
          squadId: z.string().uuid().optional().describe("UUID of the owning squad"),
        },
      },
      async ({ workspaceId, title, description, customerSegment, status, keyResultId, squadId }) => {
        const prisma = getPrisma()
        const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } })
        if (!workspace) {
          return { content: [{ type: "text" as const, text: `Workspace "${workspaceId}" not found.` }] }
        }
        const opportunity = await prisma.opportunity.create({
          data: {
            workspaceId,
            title: title.trim(),
            description: description?.trim(),
            customerSegment: customerSegment?.trim(),
            status: status ?? "EXPLORING",
            linkedKeyResultId: keyResultId ?? null,
            squadId: squadId ?? null,
          },
        })
        return {
          content: [{
            type: "text" as const,
            text: `**Opportunity created** in "${workspace.name}"\nID: ${opportunity.id}\nTitle: ${opportunity.title}\nStatus: ${opportunity.status}`,
          }],
        }
      }
    )

    register(
      "update_opportunity_status",
      {
        title: "Update Opportunity Status",
        description: "Moves an opportunity through its discovery pipeline: EXPLORING → VALIDATING → PRIORITIZED → ACTIVE → ARCHIVED.",
        inputSchema: {
          opportunityId: z.string().uuid().describe("UUID of the opportunity"),
          status: z.enum(["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "ARCHIVED"]).describe("New status"),
        },
      },
      async ({ opportunityId, status }) => {
        const prisma = getPrisma()
        const opp = await prisma.opportunity.findUnique({ where: { id: opportunityId }, select: { title: true, status: true } })
        if (!opp) {
          return { content: [{ type: "text" as const, text: `Opportunity "${opportunityId}" not found.` }] }
        }
        await prisma.opportunity.update({ where: { id: opportunityId }, data: { status } })
        return {
          content: [{
            type: "text" as const,
            text: `**"${opp.title}"** moved from ${opp.status} → ${status}`,
          }],
        }
      }
    )

    register(
      "link_opportunity_to_kr",
      {
        title: "Link Opportunity to Key Result",
        description: "Associates an opportunity with a Key Result to show which metric it is expected to move. Pass null keyResultId to clear.",
        inputSchema: {
          opportunityId: z.string().uuid().describe("UUID of the opportunity"),
          keyResultId: z.string().uuid().nullable().describe("UUID of the Key Result, or null to clear"),
        },
      },
      async ({ opportunityId, keyResultId }) => {
        const prisma = getPrisma()
        const opp = await prisma.opportunity.findUnique({ where: { id: opportunityId }, select: { title: true } })
        if (!opp) {
          return { content: [{ type: "text" as const, text: `Opportunity "${opportunityId}" not found.` }] }
        }
        await prisma.opportunity.update({ where: { id: opportunityId }, data: { linkedKeyResultId: keyResultId } })
        return {
          content: [{
            type: "text" as const,
            text: keyResultId
              ? `Linked opportunity "${opp.title}" to KR ${keyResultId}.`
              : `Cleared KR link from opportunity "${opp.title}".`,
          }],
        }
      }
    )

    register(
      "add_solution",
      {
        title: "Add Solution",
        description: "Adds a proposed Solution to an Opportunity.",
        inputSchema: {
          opportunityId: z.string().uuid().describe("UUID of the parent opportunity"),
          title: z.string().min(1).describe("Title of the proposed solution"),
          description: z.string().optional().describe("How this solution addresses the opportunity"),
        },
      },
      async ({ opportunityId, title, description }) => {
        const prisma = getPrisma()
        const opp = await prisma.opportunity.findUnique({ where: { id: opportunityId }, select: { id: true, title: true } })
        if (!opp) {
          return { content: [{ type: "text" as const, text: `Opportunity "${opportunityId}" not found.` }] }
        }
        const solution = await prisma.solution.create({ data: { opportunityId, title: title.trim(), description: description?.trim() } })
        return {
          content: [{
            type: "text" as const,
            text: `**Solution created** for "${opp.title}"\nID: ${solution.id}\nTitle: ${solution.title}\nStatus: ${solution.status}`,
          }],
        }
      }
    )

    register(
      "add_assumption",
      {
        title: "Add Assumption",
        description: "Adds a testable Assumption to a Solution. Assumptions have a risk level (HIGH/MEDIUM/LOW) and start UNTESTED.",
        inputSchema: {
          solutionId: z.string().uuid().describe("UUID of the parent solution"),
          title: z.string().min(1).describe("The assumption to be tested"),
          riskLevel: z.enum(["HIGH", "MEDIUM", "LOW"]).default("MEDIUM").describe("How risky this assumption is if wrong"),
        },
      },
      async ({ solutionId, title, riskLevel }) => {
        const prisma = getPrisma()
        const solution = await prisma.solution.findUnique({ where: { id: solutionId }, select: { id: true, title: true } })
        if (!solution) {
          return { content: [{ type: "text" as const, text: `Solution "${solutionId}" not found.` }] }
        }
        const assumption = await prisma.assumption.create({ data: { solutionId, title: title.trim(), riskLevel, status: "UNTESTED" } })
        return {
          content: [{
            type: "text" as const,
            text: `**Assumption created** on solution "${solution.title}"\nID: ${assumption.id}\nTitle: ${assumption.title}\nRisk: ${assumption.riskLevel}\nStatus: UNTESTED`,
          }],
        }
      }
    )

    register(
      "update_assumption",
      {
        title: "Update Assumption",
        description: "Updates an existing Assumption's title, risk level, or status. Use this to self-correct mistakes (wrong title, risk level) or advance status outside an experiment conclusion.",
        inputSchema: {
          assumptionId: z.string().uuid().describe("UUID of the assumption"),
          title: z.string().min(1).optional().describe("New title for the assumption"),
          riskLevel: z.enum(["HIGH", "MEDIUM", "LOW"]).optional().describe("New risk level"),
          status: z.enum(["UNTESTED", "TESTING", "VALIDATED", "INVALIDATED"]).optional().describe("New status"),
        },
      },
      updateAssumption
    )

    register(
      "delete_assumption",
      {
        title: "Delete Assumption",
        description: "Permanently deletes an Assumption. Any Experiments or Evidence linked to it are unlinked (assumptionId set to null), not deleted.",
        inputSchema: {
          assumptionId: z.string().uuid().describe("UUID of the assumption to delete"),
        },
      },
      deleteAssumption
    )

    register(
      "add_solution_plan",
      {
        title: "Add Solution Plan",
        description: "Logs a proposed implementation/engineering plan on a Solution as the pinned 'current plan' entry in its Plan & Discussion thread. A later add_solution_plan call on the same solution supersedes this one.",
        inputSchema: {
          solutionId: z.string().uuid().describe("UUID of the solution"),
          body: z.string().min(1).describe("The plan content"),
          authorName: z.string().min(1).describe("Name of the agent or person proposing this plan"),
        },
      },
      addSolutionPlan
    )

    register(
      "add_solution_comment",
      {
        title: "Add Solution Comment",
        description: "Adds a reply comment to a Solution's Plan & Discussion thread.",
        inputSchema: {
          solutionId: z.string().uuid().describe("UUID of the solution"),
          body: z.string().min(1).describe("The comment content"),
          authorName: z.string().min(1).describe("Name of the agent or person posting this comment"),
          authorType: z.enum(["AGENT", "HUMAN"]).optional().describe("Who is posting this comment (defaults to AGENT)"),
        },
      },
      addSolutionComment
    )

    register(
      "list_solution_comments",
      {
        title: "List Solution Comments",
        description: "Returns the full Plan & Discussion thread for a Solution in chronological order, each entry labeled PLAN or COMMENT.",
        inputSchema: {
          solutionId: z.string().uuid().describe("UUID of the solution"),
        },
      },
      listSolutionComments
    )

    register(
      "get_solution_comment",
      {
        title: "Get Solution Comment",
        description: "Fetches a single Solution plan or comment entry by ID.",
        inputSchema: {
          commentId: z.string().uuid().describe("UUID of the comment"),
        },
      },
      getSolutionComment
    )

    register(
      "update_solution_comment",
      {
        title: "Update Solution Comment",
        description: "Updates the body text of an existing Solution plan or comment entry.",
        inputSchema: {
          commentId: z.string().uuid().describe("UUID of the comment"),
          body: z.string().min(1).describe("New body content"),
        },
      },
      updateSolutionComment
    )

    register(
      "delete_solution_comment",
      {
        title: "Delete Solution Comment",
        description: "Permanently deletes a Solution plan or comment entry.",
        inputSchema: {
          commentId: z.string().uuid().describe("UUID of the comment to delete"),
        },
      },
      deleteSolutionComment
    )

    register(
      "approve_solution_plan",
      {
        title: "Approve Solution Plan",
        description: "Marks a PLAN entry in a Solution's Plan & Discussion thread as APPROVED. Only applies to PLAN entries — pass the ID of the plan itself, not a COMMENT reply.",
        inputSchema: {
          commentId: z.string().uuid().describe("UUID of the PLAN entry to approve"),
        },
      },
      approveSolutionPlan
    )

    register(
      "reject_solution_plan",
      {
        title: "Reject Solution Plan",
        description: "Marks a PLAN entry in a Solution's Plan & Discussion thread as REJECTED. Only applies to PLAN entries — pass the ID of the plan itself, not a COMMENT reply.",
        inputSchema: {
          commentId: z.string().uuid().describe("UUID of the PLAN entry to reject"),
        },
      },
      rejectSolutionPlan
    )

    register(
      "promote_to_roadmap",
      {
        title: "Promote Solution to Roadmap",
        description: "Promotes a validated Solution directly to the roadmap, creating a Roadmap Item with the solution's title and linking back to the originating opportunity.",
        inputSchema: {
          solutionId: z.string().uuid().describe("UUID of the solution to promote"),
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          horizon: z.enum(["NOW", "NEXT", "LATER", "SHIPPED"]).describe("Which roadmap horizon to place this in"),
          isPrivate: z.boolean().optional().describe("Set to true to hide this item from the public portal roadmap and block voting on it"),
        },
      },
      async ({ solutionId, workspaceId, horizon, isPrivate }) => {
        const prisma = getPrisma()
        const solution = await prisma.solution.findUnique({
          where: { id: solutionId },
          include: { opportunity: { select: { id: true, title: true, squadId: true } } },
        })
        if (!solution) {
          return { content: [{ type: "text" as const, text: `Solution "${solutionId}" not found.` }] }
        }
        const lastItem = await prisma.roadmapItem.findFirst({
          where: { workspaceId, horizon, status: "ACTIVE" },
          orderBy: { sortOrder: "desc" },
          select: { sortOrder: true },
        })
        const item = await prisma.roadmapItem.create({
          data: {
            workspaceId,
            title: solution.title,
            horizon,
            sortOrder: lastItem ? lastItem.sortOrder + 1 : 0,
            solutionId,
            opportunityId: solution.opportunity.id,
            squadId: solution.opportunity.squadId ?? null,
            isPrivate: isPrivate ?? false,
          },
        })
        return {
          content: [{
            type: "text" as const,
            text: `**Promoted to roadmap (${horizon})**\nRoadmap Item ID: ${item.id}\nTitle: ${item.title}` +
              (item.isPrivate ? `\nPrivate: yes (hidden from public portal)` : "") +
              `\nLinked Solution: ${solutionId}\nLinked Opportunity: ${solution.opportunity.title}`,
          }],
        }
      }
    )

    // ════════════════════════════════════════════════════════════════
    // EXPERIMENTS
    // ════════════════════════════════════════════════════════════════

    register(
      "list_experiments",
      {
        title: "List Experiments",
        description: "Lists experiments in a workspace with optional status and squad filters.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          status: z.enum(["DESIGNING", "RUNNING", "COMPLETE", "KILLED"]).optional().describe("Filter by status"),
          squadId: z.string().uuid().optional().describe("Filter by squad"),
        },
      },
      async ({ workspaceId, status, squadId }) => {
        const prisma = getPrisma()
        const experiments = await prisma.experiment.findMany({
          where: { workspaceId, ...(status ? { status } : {}), ...(squadId ? { squadId } : {}) },
          include: {
            squad: { select: { name: true } },
            assumption: { select: { title: true } },
          },
          orderBy: { createdAt: "desc" },
        })
        if (!experiments.length) {
          return { content: [{ type: "text" as const, text: "No experiments found." }] }
        }
        const lines = experiments.map(e =>
          `• **${e.title}** [${e.status}${e.conclusion ? "/" + e.conclusion : ""}]${e.squad ? ` (${e.squad.name})` : ""}` +
          (e.assumption ? ` — testing: ${e.assumption.title}` : "") +
          `\n  ID: ${e.id}`
        )
        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      }
    )

    register(
      "get_experiment",
      {
        title: "Get Experiment",
        description:
          "Returns full details for a single experiment: hypothesis, method, kill condition, " +
          "linked assumption, all logged results, and conclusion.",
        inputSchema: {
          experimentId: z.string().uuid().describe("UUID of the experiment"),
        },
      },
      async ({ experimentId }) => {
        const prisma = getPrisma()
        const experiment = await prisma.experiment.findUnique({
          where: { id: experimentId },
          include: {
            assumption: { select: { id: true, title: true, status: true } },
            squad: { select: { name: true } },
            results: { orderBy: { createdAt: "asc" } },
          },
        })
        if (!experiment) {
          return { content: [{ type: "text" as const, text: `Experiment "${experimentId}" not found.` }] }
        }
        const resultsText = experiment.results.length
          ? experiment.results.map((r, i) =>
              `  ${i + 1}. ${r.note}` +
              (r.metric ? ` [${r.metric}${r.value != null ? " = " + r.value : ""}]` : "")
            ).join("\n")
          : "  No results logged yet."
        return {
          content: [{
            type: "text" as const,
            text:
              `**${experiment.title}**\n` +
              `Status: ${experiment.status}${experiment.conclusion ? " / " + experiment.conclusion : ""}\n` +
              (experiment.squad ? `Squad: ${experiment.squad.name}\n` : "") +
              (experiment.startDate ? `Started: ${experiment.startDate.toLocaleDateString()}\n` : "") +
              (experiment.endDate ? `Ended: ${experiment.endDate.toLocaleDateString()}\n` : "") +
              `\n**Hypothesis:** ${experiment.hypothesis}\n` +
              `**Method:** ${experiment.method}\n` +
              `**Kill Condition:** ${experiment.killCondition}\n` +
              (experiment.assumption
                ? `\n**Linked Assumption:** ${experiment.assumption.title} [${experiment.assumption.status}]\n  ID: ${experiment.assumption.id}\n`
                : "\n") +
              `\n**Results (${experiment.results.length}):**\n${resultsText}`,
          }],
        }
      }
    )

    register(
      "create_experiment",
      {
        title: "Create Experiment",
        description: "Creates a new Experiment in DESIGNING status. Link it to an Assumption to close the discovery loop.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          title: z.string().min(1).describe("Short name for the experiment"),
          hypothesis: z.string().min(1).describe("What you believe to be true"),
          method: z.string().min(1).describe("How you will test it"),
          killCondition: z.string().min(1).describe("The condition that means the hypothesis is false"),
          assumptionId: z.string().uuid().optional().describe("UUID of the Assumption this experiment tests"),
          squadId: z.string().uuid().optional().describe("UUID of the squad running this experiment"),
        },
      },
      async ({ workspaceId, title, hypothesis, method, killCondition, assumptionId, squadId }) => {
        const prisma = getPrisma()
        const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } })
        if (!workspace) {
          return { content: [{ type: "text" as const, text: `Workspace "${workspaceId}" not found.` }] }
        }
        if (assumptionId) {
          const a = await prisma.assumption.findUnique({ where: { id: assumptionId } })
          if (!a) return { content: [{ type: "text" as const, text: `Assumption "${assumptionId}" not found.` }] }
        }
        const experiment = await prisma.experiment.create({
          data: { workspaceId, title: title.trim(), hypothesis: hypothesis.trim(), method: method.trim(), killCondition: killCondition.trim(), assumptionId: assumptionId ?? null, squadId: squadId ?? null, status: "DESIGNING" },
        })
        return {
          content: [{
            type: "text" as const,
            text: `**Experiment created**\nID: ${experiment.id}\nTitle: ${experiment.title}\nStatus: DESIGNING\nKill Condition: ${experiment.killCondition}`,
          }],
        }
      }
    )

    register(
      "log_experiment_result",
      {
        title: "Log Experiment Result",
        description: "Records an observation or data point for a running experiment.",
        inputSchema: {
          experimentId: z.string().uuid().describe("UUID of the experiment"),
          note: z.string().min(1).describe("Description of what was observed"),
          metric: z.string().optional().describe("Name of the metric (e.g. 'conversion rate')"),
          value: z.number().optional().describe("Numeric value for the metric"),
        },
      },
      async ({ experimentId, note, metric, value }) => {
        const prisma = getPrisma()
        const experiment = await prisma.experiment.findUnique({ where: { id: experimentId }, select: { id: true, title: true } })
        if (!experiment) {
          return { content: [{ type: "text" as const, text: `Experiment "${experimentId}" not found.` }] }
        }
        const result = await prisma.experimentResult.create({
          data: { experimentId, note: note.trim(), metric: metric?.trim(), value: value ?? null },
        })
        return {
          content: [{
            type: "text" as const,
            text: `**Result logged** for "${experiment.title}"\nID: ${result.id}\nNote: ${result.note}` +
              (result.metric ? `\nMetric: ${result.metric}${result.value != null ? " = " + result.value : ""}` : ""),
          }],
        }
      }
    )

    register(
      "conclude_experiment",
      {
        title: "Conclude Experiment",
        description: "Concludes an experiment with PROCEED (hypothesis validated), KILL (invalidated), or ITERATE (inconclusive). Automatically updates the linked Assumption status: PROCEED → VALIDATED, KILL → INVALIDATED, ITERATE → UNTESTED.",
        inputSchema: {
          experimentId: z.string().uuid().describe("UUID of the experiment"),
          conclusion: z.enum(["PROCEED", "KILL", "ITERATE"]).describe("The outcome of the experiment"),
        },
      },
      async ({ experimentId, conclusion }) => {
        const prisma = getPrisma()
        const experiment = await prisma.experiment.findUnique({
          where: { id: experimentId },
          select: { id: true, title: true, status: true, assumptionId: true },
        })
        if (!experiment) {
          return { content: [{ type: "text" as const, text: `Experiment "${experimentId}" not found.` }] }
        }
        if (experiment.status === "KILLED" || experiment.status === "COMPLETE") {
          return { content: [{ type: "text" as const, text: `Experiment "${experiment.title}" is already concluded (${experiment.status}).` }] }
        }

        const newStatus = conclusion === "KILL" ? "KILLED" : "COMPLETE"
        await prisma.experiment.update({
          where: { id: experimentId },
          data: { status: newStatus, conclusion, endDate: new Date() },
        })

        let assumptionUpdate = ""
        if (experiment.assumptionId) {
          const assumptionStatus = conclusion === "PROCEED" ? "VALIDATED" : conclusion === "KILL" ? "INVALIDATED" : "UNTESTED"
          await prisma.assumption.update({ where: { id: experiment.assumptionId }, data: { status: assumptionStatus } })
          assumptionUpdate = `\nLinked assumption updated → ${assumptionStatus}`
        }

        return {
          content: [{
            type: "text" as const,
            text: `**"${experiment.title}"** concluded as **${conclusion}**\nStatus: ${newStatus}${assumptionUpdate}`,
          }],
        }
      }
    )

    // ════════════════════════════════════════════════════════════════
    // ROADMAP
    // ════════════════════════════════════════════════════════════════

    register(
      "list_roadmap_items",
      {
        title: "List Roadmap Items",
        description:
          "Lists all active roadmap items for a workspace grouped by horizon (NOW / NEXT / LATER / LAUNCHING / LAUNCHED / SHIPPED). " +
          "Includes linked opportunity and solution titles, squad, and IDs.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          horizon: z.enum(["NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "SHIPPED"]).optional().describe("Filter to a specific horizon (omit for all)"),
          squadId: z.string().uuid().optional().describe("Filter by squad"),
        },
      },
      async ({ workspaceId, horizon, squadId }) => {
        const prisma = getPrisma()
        const items = await prisma.roadmapItem.findMany({
          where: {
            workspaceId,
            status: "ACTIVE",
            ...(horizon ? { horizon } : {}),
            ...(squadId ? { squadId } : {}),
          },
          include: {
            opportunity: { select: { title: true } },
            solution: { select: { title: true } },
            squad: { select: { name: true } },
            experiment: { select: { title: true } },
          },
          orderBy: [{ horizon: "asc" }, { sortOrder: "asc" }],
        })
        if (!items.length) {
          return { content: [{ type: "text" as const, text: "No active roadmap items found." }] }
        }
        const groups: Record<string, typeof items> = { NOW: [], NEXT: [], LATER: [], LAUNCHING: [], LAUNCHED: [] }
        for (const item of items) {
          groups[item.horizon] ??= []
          groups[item.horizon].push(item)
        }
        const sections = (["NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "SHIPPED"] as const)
          .filter(h => groups[h]?.length)
          .map(h => {
            const lines = groups[h].map(item =>
              `  • **${item.title}**${item.isPrivate ? " 🔒 PRIVATE" : ""}\n    ID: ${item.id}` +
              (item.opportunity ? `\n    Opportunity: ${item.opportunity.title}` : "") +
              (item.solution ? `\n    Solution: ${item.solution.title}` : "") +
              (item.experiment ? `\n    Experiment: ${item.experiment.title}` : "") +
              (item.squad ? `\n    Squad: ${item.squad.name}` : "") +
              (item.startDate || item.endDate
                ? `\n    Dates: ${item.startDate ? formatUtcDate(item.startDate) : "?"} – ${item.endDate ? formatUtcDate(item.endDate) : "?"}`
                : "")
            )
            return `**${h}**\n${lines.join("\n")}`
          })
        return { content: [{ type: "text" as const, text: sections.join("\n\n") }] }
      }
    )

    register(
      "update_roadmap_item",
      {
        title: "Update Roadmap Item",
        description:
          "Updates an existing roadmap item's horizon, status, title, description, or dates. " +
          "Use horizon to move items between NOW / NEXT / LATER. Use status ARCHIVED to remove from view. " +
          "LAUNCHING and LAUNCHED cannot be set here — use set_launch_tier to move an item into LAUNCHING.",
        inputSchema: {
          itemId: z.string().uuid().describe("UUID of the roadmap item"),
          horizon: z.enum(["NOW", "NEXT", "LATER", "LAUNCHING", "LAUNCHED", "SHIPPED"]).optional().describe("Move to a new horizon (LAUNCHING/LAUNCHED are rejected here — use set_launch_tier)"),
          status: z.enum(["ACTIVE", "ARCHIVED"]).optional().describe("Set to ARCHIVED to hide from roadmap"),
          title: z.string().min(1).optional().describe("New title for the item"),
          description: z.string().optional().describe("New description"),
          startDate: z.string().optional().describe("ISO date string for the item's start date, e.g. '2026-07-01'"),
          endDate: z.string().optional().describe("ISO date string for the item's end date, e.g. '2026-09-30'"),
          isPrivate: z.boolean().optional().describe("Set to true to hide this item from the public portal roadmap and block voting on it"),
        },
      },
      async ({ itemId, horizon, status, title, description, startDate, endDate, isPrivate }) => {
        if (horizon === "LAUNCHING") {
          return {
            content: [{
              type: "text" as const,
              text: `Cannot set horizon to LAUNCHING directly — use set_launch_tier, which also picks a launch tier and attaches a checklist.`,
            }],
          }
        }
        if (horizon === "LAUNCHED") {
          return {
            content: [{
              type: "text" as const,
              text: `Cannot set horizon to LAUNCHED — the launch-readiness gate for this transition isn't implemented yet.`,
            }],
          }
        }
        const prisma = getPrisma()
        const item = await prisma.roadmapItem.findUnique({ where: { id: itemId }, select: { id: true, title: true, horizon: true, status: true } })
        if (!item) {
          return { content: [{ type: "text" as const, text: `Roadmap item "${itemId}" not found.` }] }
        }
        const updated = await prisma.roadmapItem.update({
          where: { id: itemId },
          data: {
            ...(horizon ? { horizon } : {}),
            ...(status ? { status } : {}),
            ...(title ? { title: title.trim() } : {}),
            ...(description !== undefined ? { description: description.trim() } : {}),
            ...(startDate !== undefined ? { startDate: new Date(startDate) } : {}),
            ...(endDate !== undefined ? { endDate: new Date(endDate) } : {}),
            ...(isPrivate !== undefined ? { isPrivate } : {}),
            updatedAt: new Date(),
          },
        })
        return {
          content: [{
            type: "text" as const,
            text:
              `**Roadmap item updated**\nID: ${updated.id}\nTitle: ${updated.title}\n` +
              `Horizon: ${updated.horizon}\nStatus: ${updated.status}` +
              (updated.isPrivate ? `\nPrivate: yes (hidden from public portal)` : "") +
              (updated.startDate || updated.endDate
                ? `\nDates: ${updated.startDate ? formatUtcDate(updated.startDate) : "?"} – ${updated.endDate ? formatUtcDate(updated.endDate) : "?"}`
                : ""),
          }],
        }
      }
    )

    register(
      "add_to_roadmap",
      {
        title: "Add to Roadmap",
        description: "Creates a Roadmap Item in the NOW, NEXT, or LATER horizon. Optionally links to a Solution, Key Result, Opportunity, and/or Squad.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          title: z.string().min(1).describe("Title of the roadmap item"),
          horizon: z.enum(["NOW", "NEXT", "LATER", "SHIPPED"]).describe("Which horizon to place this item in"),
          description: z.string().optional(),
          solutionId: z.string().uuid().optional().describe("UUID of the Solution driving this item"),
          keyResultId: z.string().uuid().optional().describe("UUID of the Key Result this item is driving"),
          opportunityId: z.string().uuid().optional().describe("UUID of the Opportunity this item addresses"),
          squadId: z.string().uuid().optional().describe("UUID of the owning squad"),
          startDate: z.string().optional().describe("ISO date string for the item's start date, e.g. '2026-07-01'"),
          endDate: z.string().optional().describe("ISO date string for the item's end date, e.g. '2026-09-30'"),
          isPrivate: z.boolean().optional().describe("Set to true to hide this item from the public portal roadmap and block voting on it (e.g. internal security work)"),
        },
      },
      async ({ workspaceId, title, horizon, description, solutionId, keyResultId, opportunityId, squadId, startDate, endDate, isPrivate }) => {
        const prisma = getPrisma()
        const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } })
        if (!workspace) {
          return { content: [{ type: "text" as const, text: `Workspace "${workspaceId}" not found.` }] }
        }
        const lastItem = await prisma.roadmapItem.findFirst({
          where: { workspaceId, horizon, status: "ACTIVE" },
          orderBy: { sortOrder: "desc" },
          select: { sortOrder: true },
        })
        const item = await prisma.roadmapItem.create({
          data: {
            workspaceId,
            title: title.trim(),
            horizon,
            description: description?.trim(),
            sortOrder: lastItem ? lastItem.sortOrder + 1 : 0,
            solutionId: solutionId ?? null,
            keyResultId: keyResultId ?? null,
            opportunityId: opportunityId ?? null,
            squadId: squadId ?? null,
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            isPrivate: isPrivate ?? false,
          },
        })
        return {
          content: [{
            type: "text" as const,
            text: `**Roadmap item created** (${horizon})\nID: ${item.id}\nTitle: ${item.title}` +
              (item.isPrivate ? `\nPrivate: yes (hidden from public portal)` : "") +
              (solutionId ? `\nLinked Solution: ${solutionId}` : "") +
              (keyResultId ? `\nLinked KR: ${keyResultId}` : "") +
              (opportunityId ? `\nLinked Opportunity: ${opportunityId}` : "") +
              (item.startDate || item.endDate
                ? `\nDates: ${item.startDate ? formatUtcDate(item.startDate) : "?"} – ${item.endDate ? formatUtcDate(item.endDate) : "?"}`
                : ""),
          }],
        }
      }
    )

    register(
      "create_checklist_template",
      {
        title: "Create Checklist Template",
        description:
          "Creates a reusable launch checklist template for a workspace, scoped to a launch tier " +
          "(TIER_1 major / TIER_2 minor / TIER_3 silent). set_launch_tier auto-resolves the workspace's " +
          "most recent ACTIVE template for a tier when no explicit templateId is given.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          tier: z.enum(["TIER_1", "TIER_2", "TIER_3"]).describe("Launch tier this template is for"),
          name: z.string().min(1).describe("Name of the template"),
          description: z.string().optional().describe("Optional description"),
          items: z.array(z.object({
            label: z.string().min(1).describe("Checklist item label"),
            description: z.string().optional().describe("Optional item description"),
          })).describe("Ordered list of checklist items"),
        },
      },
      createChecklistTemplate
    )

    register(
      "list_checklist_templates",
      {
        title: "List Checklist Templates",
        description: "Lists checklist templates for a workspace, optionally filtered by launch tier.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          tier: z.enum(["TIER_1", "TIER_2", "TIER_3"]).optional().describe("Filter to a specific launch tier"),
        },
      },
      listChecklistTemplates
    )

    register(
      "set_launch_tier",
      {
        title: "Set Launch Tier",
        description:
          "Moves a roadmap item into the LAUNCHING horizon by picking a launch tier and attaching a " +
          "checklist cloned from a checklist template. Rejects items that are already LAUNCHING or LAUNCHED. " +
          "If templateId is omitted, resolves the workspace's most recent ACTIVE template for the given tier.",
        inputSchema: {
          itemId: z.string().uuid().describe("UUID of the roadmap item"),
          tier: z.enum(["TIER_1", "TIER_2", "TIER_3"]).describe("Launch tier to set"),
          templateId: z.string().uuid().optional().describe("UUID of a specific checklist template to use (must match tier)"),
        },
      },
      setLaunchTier
    )

    register(
      "get_launch_checklist",
      {
        title: "Get Launch Checklist",
        description: "Returns the launch checklist for a roadmap item, including each item's status and ID.",
        inputSchema: {
          roadmapItemId: z.string().uuid().describe("UUID of the roadmap item"),
        },
      },
      getLaunchChecklist
    )

    register(
      "update_launch_checklist_item",
      {
        title: "Update Launch Checklist Item",
        description: "Sets the status of a single launch checklist item (PENDING, DONE, or SKIPPED).",
        inputSchema: {
          itemId: z.string().uuid().describe("UUID of the launch checklist item"),
          status: z.enum(["PENDING", "DONE", "SKIPPED"]).describe("New status for the item"),
        },
      },
      updateLaunchChecklistItem
    )

    // ════════════════════════════════════════════════════════════════
    // SQUADS
    // ════════════════════════════════════════════════════════════════

    register(
      "create_squad",
      {
        title: "Create Squad",
        description: "Creates a new squad in a workspace. Returns the squad ID, name, and color.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          name: z.string().trim().min(1).describe("Human-readable squad name"),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/, "Color must be a six-digit hex value such as #6366f1")
            .optional()
            .describe("Squad color as a six-digit hex value (defaults to #6366f1)"),
        },
      },
      createSquad
    )

    register(
      "list_squads",
      {
        title: "List Squads",
        description: "Lists all squads in a workspace with their IDs and colors.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
        },
      },
      listSquads
    )

    register(
      "get_squad",
      {
        title: "Get Squad",
        description: "Returns a squad's ID, workspace ID, name, and color.",
        inputSchema: {
          squadId: z.string().uuid().describe("UUID of the squad"),
        },
      },
      getSquad
    )

    register(
      "update_squad",
      {
        title: "Update Squad",
        description: "Updates a squad's name and/or color. Returns the updated squad.",
        inputSchema: {
          squadId: z.string().uuid().describe("UUID of the squad"),
          name: z.string().trim().min(1).optional().describe("New human-readable squad name"),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/, "Color must be a six-digit hex value such as #6366f1")
            .optional()
            .describe("New squad color as a six-digit hex value"),
        },
      },
      updateSquad
    )

    register(
      "assign_squad",
      {
        title: "Assign Squad",
        description: "Assigns a Squad to any object: opportunity, experiment, roadmap_item, objective, or task. Pass null squadId to clear.",
        inputSchema: {
          objectType: z.enum(["opportunity", "experiment", "roadmap_item", "objective", "task"]).describe("Type of object to assign the squad to"),
          objectId: z.string().uuid().describe("UUID of the object"),
          squadId: z.string().uuid().nullable().describe("UUID of the squad, or null to clear"),
        },
      },
      async ({ objectType, objectId, squadId }) => {
        const prisma = getPrisma()
        const data = { squadId }
        switch (objectType) {
          case "opportunity":
            await prisma.opportunity.update({ where: { id: objectId }, data })
            break
          case "experiment":
            await prisma.experiment.update({ where: { id: objectId }, data })
            break
          case "roadmap_item":
            await prisma.roadmapItem.update({ where: { id: objectId }, data })
            break
          case "objective":
            await prisma.objective.update({ where: { id: objectId }, data })
            break
          case "task":
            await prisma.task.update({ where: { id: objectId }, data: { ...data, updatedAt: new Date() } })
            break
        }
        return {
          content: [{
            type: "text" as const,
            text: squadId
              ? `Squad ${squadId} assigned to ${objectType} ${objectId}.`
              : `Squad cleared from ${objectType} ${objectId}.`,
          }],
        }
      }
    )

    // ════════════════════════════════════════════════════════════════
    // TASKS
    // ════════════════════════════════════════════════════════════════

    register(
      "create_task",
      {
        title: "Create Task",
        description:
          "Creates a Task — the standalone delivery/tracking entity used for both full engineering sprint delivery " +
          "and lightweight PM initiative tracking. Defaults to status TODO and priority MEDIUM. Set parentTaskId to " +
          "create a Subtask under an Epic (a Task with no parent and children is an Epic).",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          title: z.string().min(1).describe("Task title"),
          description: z.string().optional().describe("Optional description"),
          status: z.enum(["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"]).optional().describe("Initial status (default TODO)"),
          priority: z.enum(["URGENT", "HIGH", "MEDIUM", "LOW"]).optional().describe("Priority (default MEDIUM)"),
          squadId: z.string().uuid().optional().describe("Owning squad UUID"),
          parentTaskId: z.string().uuid().optional().describe("Parent task UUID, to create this as a Subtask"),
          assigneeUserId: z.string().uuid().optional().describe("UUID of the assignee's WorkspaceMember userId"),
          ownerName: z.string().optional().describe("Freeform owner name for non-Compass stakeholders"),
          storyPoints: z.number().optional().describe("Story points estimate"),
          dueDate: z.string().optional().describe("Due date, ISO 8601"),
          iteration: z.string().optional().describe("Freeform sprint/iteration label, e.g. 'Sprint 24'"),
        },
      },
      createTask
    )

    register(
      "get_task",
      {
        title: "Get Task",
        description: "Returns full detail for a Task: fields, parent Epic (if any), subtasks, and resolved links to other Compass objects.",
        inputSchema: {
          taskId: z.string().uuid().describe("UUID of the task"),
        },
      },
      getTask
    )

    register(
      "list_tasks",
      {
        title: "List Tasks",
        description:
          "Lists tasks in a workspace, filterable by status, priority, squad, assignee, parent (pass parentTaskId " +
          "explicitly as null to list only top-level Epics/tasks), or a linkedType+linkedId pair (e.g. all tasks " +
          "linked to an Opportunity). Set includeSubtasks to nest children under their parent in the response.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          status: z.enum(["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"]).optional().describe("Filter by status"),
          priority: z.enum(["URGENT", "HIGH", "MEDIUM", "LOW"]).optional().describe("Filter by priority"),
          squadId: z.string().uuid().optional().describe("Filter by owning squad"),
          assigneeUserId: z.string().uuid().optional().describe("Filter by assignee"),
          parentTaskId: z.string().uuid().nullable().optional().describe("Filter by parent task; pass null for top-level tasks/Epics only"),
          linkedType: z.enum(["OPPORTUNITY", "SOLUTION", "ROADMAP_ITEM", "OBJECTIVE", "KEY_RESULT", "DOC", "EXPERIMENT", "FEEDBACK_ITEM"]).optional().describe("Filter to tasks linked to this object type (pair with linkedId)"),
          linkedId: z.string().uuid().optional().describe("UUID of the linked object (pair with linkedType)"),
          includeSubtasks: z.boolean().optional().describe("Nest subtasks under their parent in the response"),
        },
      },
      listTasks
    )

    register(
      "update_task",
      {
        title: "Update Task",
        description:
          "Updates a Task's title/description/priority/assignee/owner/story points/due date/iteration. " +
          "Does not accept status — use move_task_status for status transitions.",
        inputSchema: {
          taskId: z.string().uuid().describe("UUID of the task"),
          title: z.string().min(1).optional().describe("New title"),
          description: z.string().optional().describe("New description"),
          priority: z.enum(["URGENT", "HIGH", "MEDIUM", "LOW"]).optional().describe("New priority"),
          squadId: z.string().uuid().nullable().optional().describe("New owning squad, or null to clear"),
          assigneeUserId: z.string().uuid().nullable().optional().describe("New assignee userId, or null to clear"),
          ownerName: z.string().nullable().optional().describe("New freeform owner name, or null to clear"),
          storyPoints: z.number().nullable().optional().describe("New story points, or null to clear"),
          dueDate: z.string().nullable().optional().describe("New due date (ISO 8601), or null to clear"),
          iteration: z.string().nullable().optional().describe("New iteration label, or null to clear"),
        },
      },
      updateTask
    )

    register(
      "move_task_status",
      {
        title: "Move Task Status",
        description:
          "Dedicated status-transition tool for a Task — BACKLOG, TODO, IN_PROGRESS, BLOCKED, IN_REVIEW, DONE, or " +
          "CANCELLED. BLOCKED is a first-class status, not a flag. Places the task at the end of the destination column.",
        inputSchema: {
          taskId: z.string().uuid().describe("UUID of the task"),
          status: z.enum(["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"]).describe("New status"),
        },
      },
      moveTaskStatus
    )

    register(
      "link_task",
      {
        title: "Link Task",
        description:
          "Links a Task to another Compass object (Opportunity, Solution, Roadmap Item, Objective, Key Result, Doc, " +
          "Experiment, or Feedback Item). Idempotent — re-linking the same pair is a no-op, not an error.",
        inputSchema: {
          taskId: z.string().uuid().describe("UUID of the task"),
          linkedType: z.enum(["OPPORTUNITY", "SOLUTION", "ROADMAP_ITEM", "OBJECTIVE", "KEY_RESULT", "DOC", "EXPERIMENT", "FEEDBACK_ITEM"]).describe("Type of the object to link"),
          linkedId: z.string().uuid().describe("UUID of the object to link"),
        },
      },
      linkTask
    )

    register(
      "unlink_task",
      {
        title: "Unlink Task",
        description: "Removes a link between a Task and another Compass object.",
        inputSchema: {
          taskId: z.string().uuid().describe("UUID of the task"),
          linkedType: z.enum(["OPPORTUNITY", "SOLUTION", "ROADMAP_ITEM", "OBJECTIVE", "KEY_RESULT", "DOC", "EXPERIMENT", "FEEDBACK_ITEM"]).describe("Type of the linked object"),
          linkedId: z.string().uuid().describe("UUID of the linked object"),
        },
      },
      unlinkTask
    )

    register(
      "list_task_links",
      {
        title: "List Task Links",
        description: "Returns all links for a Task, grouped by linked object type, each resolved to a human-readable title.",
        inputSchema: {
          taskId: z.string().uuid().describe("UUID of the task"),
        },
      },
      listTaskLinks
    )

    // ════════════════════════════════════════════════════════════════
    // FEEDBACK
    // ════════════════════════════════════════════════════════════════

    register(
      "list_feedback",
      {
        title: "List Feedback",
        description:
          "Lists customer feedback items for a workspace. Useful for discovering insights to turn into opportunities. " +
          "Returns feedback with vote counts, linked opportunities, and status.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          status: z.enum(["OPEN", "UNDER_REVIEW", "PLANNED", "CLOSED"]).optional().describe("Filter by status (omit for all)"),
          limit: z.number().int().min(1).max(100).optional().default(50).describe("Max items to return (default 50)"),
        },
      },
      async ({ workspaceId, status, limit }) => {
        const prisma = getPrisma()
        const items = await prisma.feedbackItem.findMany({
          where: { workspaceId, ...(status ? { status } : {}) },
          include: { opportunity: { select: { title: true } } },
          orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
          take: limit ?? 50,
        })
        if (!items.length) {
          return { content: [{ type: "text" as const, text: "No feedback found." }] }
        }
        const lines = items.map(f =>
          `• [${f.type}] **${f.title}** [${f.status}] 👍 ${f.voteCount}\n` +
          `  ID: ${f.id}\n` +
          (f.description ? `  ${f.description.slice(0, 100)}${f.description.length > 100 ? "…" : ""}\n` : "") +
          (f.opportunity ? `  → Linked opportunity: ${f.opportunity.title}\n` : "") +
          (f.submitterName ? `  Submitted by: ${f.submitterName}` : "")
        )
        return { content: [{ type: "text" as const, text: lines.join("\n\n") }] }
      }
    )

    register(
      "get_feedback_item",
      {
        title: "Get Feedback Item",
        description:
          "Returns full details for a single feedback item including all fields and linked opportunity details if present.",
        inputSchema: {
          feedbackId: z.string().uuid().describe("UUID of the feedback item"),
        },
      },
      getFeedbackItem
    )

    register(
      "update_feedback_status",
      {
        title: "Update Feedback Status",
        description:
          "Updates the status of a feedback item. Optionally include a note explaining the reason for the status change.",
        inputSchema: {
          feedbackId: z.string().uuid().describe("UUID of the feedback item"),
          status: z.enum(["OPEN", "UNDER_REVIEW", "PLANNED", "CLOSED"]).describe("New status for the feedback item"),
          note: z.string().optional().describe("Optional reason for the status change"),
        },
      },
      updateFeedbackStatus
    )

    register(
      "link_feedback_to_opportunity",
      {
        title: "Link Feedback to Opportunity",
        description:
          "Links a feedback item to an existing opportunity. Both must belong to the same workspace. " +
          "Use this to connect customer signals to product opportunities in the OST.",
        inputSchema: {
          feedbackId: z.string().uuid().describe("UUID of the feedback item"),
          opportunityId: z.string().uuid().describe("UUID of the opportunity to link to"),
        },
      },
      linkFeedbackToOpportunity
    )

    register(
      "update_feedback_type",
      {
        title: "Update Feedback Type",
        description:
          "Reclassifies a feedback item as a BUG or an IDEA. Bugs can be promoted directly to the " +
          "roadmap via promote_feedback_to_roadmap; ideas follow the normal Opportunity → Solution " +
          "discovery flow via link_feedback_to_opportunity.",
        inputSchema: {
          feedbackId: z.string().uuid().describe("UUID of the feedback item"),
          type: z.enum(["BUG", "IDEA"]).describe("New type for the feedback item"),
        },
      },
      updateFeedbackType
    )

    register(
      "promote_feedback_to_roadmap",
      {
        title: "Promote Feedback to Roadmap",
        description:
          "Promotes a feedback item (typically a BUG) directly to the roadmap, skipping the " +
          "Opportunity → Solution → Assumption → Experiment discovery flow. Creates a Roadmap Item " +
          "using the feedback's title and links back to the originating feedback.",
        inputSchema: {
          feedbackId: z.string().uuid().describe("UUID of the feedback item to promote"),
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          horizon: z.enum(["NOW", "NEXT", "LATER", "SHIPPED"]).describe("Which roadmap horizon to place this in"),
          isPrivate: z.boolean().optional().describe("Set to true to hide this item from the public portal roadmap and block voting on it (e.g. a security-flagged bug)"),
        },
      },
      promoteFeedbackToRoadmap
    )

    // ════════════════════════════════════════════════════════════════
    // EVIDENCE
    // ════════════════════════════════════════════════════════════════

    register(
      "add_evidence",
      {
        title: "Add Evidence",
        description:
          "Attaches a new piece of evidence (customer signal) to an opportunity, solution, or assumption. " +
          "Exactly one of opportunityId, solutionId, or assumptionId must be provided. " +
          "Use this to record why the team believes an OST node is real — an interview quote, a support ticket, " +
          "an experiment result, analytics data, or feedback.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          sourceType: z.enum(["interview", "feedback", "support_ticket", "experiment_result", "analytics"])
            .describe("Where this evidence came from"),
          excerpt: z.string().describe("The evidence text — a quote, summary, or data point"),
          confidence: z.enum(["high", "medium", "low"]).optional().describe("Confidence level (default medium)"),
          sourceUrl: z.string().url().optional().describe("Optional link to the source (ticket, recording, doc)"),
          opportunityId: z.string().uuid().optional().describe("UUID of the opportunity to attach to"),
          solutionId: z.string().uuid().optional().describe("UUID of the solution to attach to"),
          assumptionId: z.string().uuid().optional().describe("UUID of the assumption to attach to"),
        },
      },
      addEvidence
    )

    register(
      "link_evidence",
      {
        title: "Link Evidence",
        description:
          "Re-parents an existing evidence row to a different OST node. " +
          "Exactly one of opportunityId, solutionId, or assumptionId must be provided; the other two are cleared.",
        inputSchema: {
          evidenceId: z.string().uuid().describe("UUID of the evidence to re-link"),
          opportunityId: z.string().uuid().optional().describe("UUID of the opportunity to attach to"),
          solutionId: z.string().uuid().optional().describe("UUID of the solution to attach to"),
          assumptionId: z.string().uuid().optional().describe("UUID of the assumption to attach to"),
        },
      },
      linkEvidence
    )

    register(
      "list_evidence",
      {
        title: "List Evidence",
        description:
          "Lists all evidence attached to a given opportunity, solution, or assumption. " +
          "Returns each item's source type, confidence, excerpt, source URL, and creation date.",
        inputSchema: {
          nodeId: z.string().uuid().describe("UUID of the opportunity, solution, or assumption"),
          nodeType: z.enum(["opportunity", "solution", "assumption"]).describe("Type of the node identified by nodeId"),
        },
      },
      listEvidence
    )

    // ════════════════════════════════════════════════════════════════
    // DOCS
    // ════════════════════════════════════════════════════════════════

    register(
      "list_docs",
      {
        title: "List Docs",
        description:
          "Lists all docs in a workspace as an indented tree. " +
          "Returns each doc's ID, title, icon, and child count. " +
          "Use this to discover doc IDs before calling get_doc or update_doc.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
        },
      },
      listDocs
    )

    register(
      "get_doc",
      {
        title: "Get Doc",
        description:
          "Returns the full content of a single doc, including its parent, " +
          "children list, and the complete markdown body.",
        inputSchema: {
          docId: z.string().uuid().describe("UUID of the doc"),
        },
      },
      getDoc
    )

    register(
      "create_doc",
      {
        title: "Create Doc",
        description:
          "Creates a new doc in a workspace. Optionally nest it under a parent doc. " +
          "Content should be markdown. Returns the new doc ID and the docs URL. " +
          "Pass roadmapItemId and docType: GTM_POSITIONING_BRIEF to create a Positioning & Messaging Brief " +
          "linked 1:1 to a roadmap item -- if content is omitted, a starter template is used.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          title: z.string().min(1).describe("Doc title"),
          content: z.string().optional().describe("Doc body in markdown"),
          parentId: z
            .string()
            .uuid()
            .nullable()
            .optional()
            .describe("UUID of a parent doc to nest this under (omit for root)"),
          icon: z.string().optional().describe("Emoji or icon string, e.g. '📋'"),
          roadmapItemId: z
            .string()
            .uuid()
            .nullable()
            .optional()
            .describe("UUID of a roadmap item to link this doc to as its Positioning & Messaging Brief (1:1 -- fails if that item already has a linked doc)"),
          docType: z
            .enum(["STANDARD", "GTM_POSITIONING_BRIEF"])
            .optional()
            .describe("Doc type. GTM_POSITIONING_BRIEF auto-fills a starter template when content is omitted. Defaults to STANDARD."),
        },
      },
      createDoc
    )

    register(
      "update_doc",
      {
        title: "Update Doc",
        description:
          "Updates an existing doc's title, content, and/or icon. " +
          "Only the fields you provide are changed.",
        inputSchema: {
          docId: z.string().uuid().describe("UUID of the doc to update"),
          title: z.string().min(1).optional().describe("New title"),
          content: z.string().optional().describe("New markdown content (replaces existing)"),
          icon: z.string().optional().describe("New emoji or icon string"),
        },
      },
      updateDoc
    )

    register(
      "create_doc_version",
      {
        title: "Create Doc Version",
        description:
          "Saves a manual, named snapshot of a doc's current content. Unlike the automatic " +
          "snapshots taken before every overwriting update_doc call, this always writes a new " +
          "version -- it never gets coalesced away by the 5-minute same-author window.",
        inputSchema: {
          docId: z.string().uuid().describe("UUID of the doc to snapshot"),
          label: z.string().optional().describe("Optional label for this snapshot, e.g. 'Before big rewrite'"),
          authorName: z.string().min(1).describe("Name to attribute this snapshot to"),
        },
      },
      createDocVersion
    )

    register(
      "list_doc_versions",
      {
        title: "List Doc Versions",
        description:
          "Lists all saved versions of a doc (id, label, author, created date), newest first, " +
          "alongside the doc's own current title and last-updated time as a reference point. " +
          "Does not include full content -- call get_doc_version for that.",
        inputSchema: {
          docId: z.string().uuid().describe("UUID of the doc"),
        },
      },
      listDocVersions
    )

    register(
      "get_doc_version",
      {
        title: "Get Doc Version",
        description: "Returns the full content/title/metadata/icon snapshot of a single saved doc version.",
        inputSchema: {
          versionId: z.string().uuid().describe("UUID of the doc version"),
        },
      },
      getDocVersion
    )

    register(
      "restore_doc_version",
      {
        title: "Restore Doc Version",
        description:
          "Restores a doc's live content to a previously saved version. The doc's CURRENT state is " +
          "snapshotted first (labeled 'Before restore'), so restoring never loses data -- you can " +
          "always restore back to what was there before.",
        inputSchema: {
          versionId: z.string().uuid().describe("UUID of the doc version to restore"),
        },
      },
      restoreDocVersion
    )

    // ════════════════════════════════════════════════════════════════
    // HELP
    // ════════════════════════════════════════════════════════════════
    // Unlike every other tool above, these are NOT workspace-scoped: they
    // search Compass's own static product documentation (docs/content/*.md,
    // rendered at /help/[slug]) so any agent can answer "how do I do X in
    // Compass" questions. See the no-op gate note in lib/mcp-tool-gates.ts.

    register(
      "search_help",
      {
        title: "Search Help",
        description:
          "Full-text search over Compass's own product/usage documentation (the same content " +
          "rendered at /help/[slug]). Returns the best-matching doc section(s) for the query, each " +
          "with a Path pointer (deep-linking to a heading anchor when the match is under one) and a " +
          "short excerpt. Use this to answer 'how do I do X in Compass' questions grounded in " +
          "Compass's actual documentation, without relying on a locally-installed skill.",
        inputSchema: {
          query: z.string().min(1).describe("Search terms, e.g. 'how do I link feedback to an opportunity'"),
          limit: z.number().int().positive().optional().describe("Max results to return (default 5)"),
        },
      },
      searchHelp
    )

    register(
      "get_help",
      {
        title: "Get Help",
        description:
          "Resolves a free-text topic (a doc slug, title, or close match) to a single Compass help " +
          "doc and returns its full raw markdown content, plus its /help/[slug] path. Use search_help " +
          "first if you don't already know which doc covers the topic.",
        inputSchema: {
          topic: z.string().min(1).describe("Topic to look up, e.g. 'roadmap' or 'mcp api'"),
        },
      },
      getHelp
    )

    // ════════════════════════════════════════════════════════════════
    // SCORING
    // ════════════════════════════════════════════════════════════════

    const metricInputSchema = z.object({
      key: z.string().min(1).describe("Stable machine key, e.g. \"reach\" (immutable after creation)"),
      label: z.string().min(1).describe("Human-readable label, e.g. \"Reach\""),
      description: z.string().optional().describe("Optional explanation of what this metric measures"),
      minValue: z.number().describe("Minimum allowed raw input value"),
      maxValue: z.number().describe("Maximum allowed raw input value"),
      weight: z.number().describe("Scalar multiplier applied before the metric enters the formula (1 = no extra weighting)"),
      direction: z.enum(["POSITIVE", "NEGATIVE"]).describe("POSITIVE increases the score, NEGATIVE decreases it (e.g. Effort)"),
    })

    register(
      "list_scoring_models",
      {
        title: "List Scoring Models",
        description:
          "Lists an organization's scoring model templates (e.g. RICE, ICE) with status, formula " +
          "type, version, and metric counts. Use this to discover scoring model IDs before calling " +
          "get_scoring_model, update_scoring_model, or set_workspace_scoring_model.",
        inputSchema: {
          orgSlug: z.string().describe("Slug of the organization"),
        },
      },
      listScoringModels
    )

    register(
      "get_scoring_model",
      {
        title: "Get Scoring Model",
        description:
          "Returns full detail for a single scoring model, including every metric's key, label, " +
          "bounds, weight, and direction.",
        inputSchema: {
          scoringModelId: z.string().uuid().describe("UUID of the scoring model"),
        },
      },
      getScoringModel
    )

    register(
      "create_scoring_model",
      {
        title: "Create Scoring Model",
        description:
          "Creates a new org-level scoring model template with its metrics. Formula type is either " +
          "WEIGHTED_SUM (metrics summed/subtracted by direction) or MULTIPLICATIVE (true RICE-style " +
          "Reach×Impact×Confidence÷Effort) — for MULTIPLICATIVE, every metric's minValue must be " +
          "greater than 0.",
        inputSchema: {
          orgSlug: z.string().describe("Slug of the organization"),
          name: z.string().min(1).describe("Name of the scoring model, e.g. \"RICE\""),
          description: z.string().optional().describe("Optional description of when to use this model"),
          formulaType: z.enum(["WEIGHTED_SUM", "MULTIPLICATIVE"]).describe("Formula type"),
          metrics: z.array(metricInputSchema).describe("The model's metrics, in display order"),
        },
      },
      createScoringModel
    )

    register(
      "update_scoring_model",
      {
        title: "Update Scoring Model",
        description:
          "Updates a scoring model's name/description and/or replaces its metrics. Only the fields " +
          "you provide are changed. Providing `metrics` replaces the full metric set and bumps the " +
          "model's version — existing OpportunityScore rows keep their own frozen formula snapshot " +
          "and are unaffected until re-scored.",
        inputSchema: {
          scoringModelId: z.string().uuid().describe("UUID of the scoring model to update"),
          name: z.string().min(1).optional().describe("New name"),
          description: z.string().optional().describe("New description"),
          formulaType: z.enum(["WEIGHTED_SUM", "MULTIPLICATIVE"]).optional().describe("New formula type (only applied when metrics is also provided)"),
          metrics: z.array(metricInputSchema).optional().describe("Full replacement metric set (bumps version)"),
        },
      },
      updateScoringModel
    )

    register(
      "archive_scoring_model",
      {
        title: "Archive Scoring Model",
        description:
          "Archives a scoring model (status ARCHIVED). Archive-only — never hard-deleted, since " +
          "workspaces or historical scores may still reference it. Archived models are hidden from " +
          "the workspace picker for new selections but remain valid for existing usages.",
        inputSchema: {
          scoringModelId: z.string().uuid().describe("UUID of the scoring model to archive"),
        },
      },
      archiveScoringModel
    )

    register(
      "get_workspace_scoring_model",
      {
        title: "Get Workspace Scoring Model",
        description:
          "Returns the scoring model currently active for a workspace, including all its metrics. " +
          "Returns a message indicating no active model if none is set.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
        },
      },
      getWorkspaceScoringModel
    )

    register(
      "set_workspace_scoring_model",
      {
        title: "Set Workspace Scoring Model",
        description:
          "Sets (or clears, by omitting scoringModelId) the workspace's active scoring model. " +
          "Members can then score opportunities against it via score_opportunity.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          scoringModelId: z.string().uuid().nullable().describe("UUID of the scoring model to activate, or null to clear"),
        },
      },
      setWorkspaceScoringModel
    )

    register(
      "score_opportunity",
      {
        title: "Score Opportunity",
        description:
          "Computes and saves a score for an opportunity using its workspace's active scoring " +
          "model. Validates each raw value against the metric's bounds, then upserts the raw and " +
          "0-100 normalized score along with a frozen snapshot of the formula that produced it.",
        inputSchema: {
          opportunityId: z.string().uuid().describe("UUID of the opportunity to score"),
          rawValues: z
            .record(z.string(), z.number())
            .describe("Map of metric key -> raw input value, e.g. { \"reach\": 8, \"effort\": 2 }"),
        },
      },
      scoreOpportunity
    )

    register(
      "get_opportunity_score",
      {
        title: "Get Opportunity Score",
        description:
          "Returns an opportunity's saved score (raw and normalized), the model version it was " +
          "scored under, and a `stale` flag that is true when the live scoring model has since been " +
          "updated to a newer version.",
        inputSchema: {
          opportunityId: z.string().uuid().describe("UUID of the opportunity"),
        },
      },
      getOpportunityScore
    )

    register(
      "list_top_opportunities",
      {
        title: "List Top Opportunities",
        description:
          "Lists scored opportunities ranked by normalized score (0-100), descending. Pass " +
          "workspaceId for a single-workspace ranking, or orgSlug (without workspaceId) for a " +
          "cross-workspace \"what matters most\" view comparable across different scoring templates.",
        inputSchema: {
          workspaceId: z.string().uuid().optional().describe("UUID of the workspace (single-workspace view)"),
          orgSlug: z.string().optional().describe("Slug of the organization (cross-workspace view; omit workspaceId)"),
          limit: z.number().int().min(1).max(100).optional().describe("Max items to return (default 20)"),
        },
      },
      listTopOpportunities
    )

  },
  {},
  {
    basePath: "/api",
    disableSse: true,
    maxDuration: 60,
  }
)

async function withMcpAuth(req: Request): Promise<Response> {
  const auth = await validateMcpAuth(req)
  if (!auth.valid) {
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } })
  }
  // Carry the acting identity (userId, or null for the shared service key)
  // into every tool via AsyncLocalStorage; the register() wrapper reads it to
  // run each tool's authorization gate before its handler.
  return runWithMcpActor({ userId: auth.userId }, () => _handler(req))
}

export async function GET(req: Request) { return withMcpAuth(req) }
export async function POST(req: Request) { return withMcpAuth(req) }
