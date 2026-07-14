// MCP_API_KEY — set in Vercel project settings and .env.local.
// All MCP requests require:  Authorization: Bearer <MCP_API_KEY>
//
// Endpoint: POST /api/mcp  (Streamable HTTP transport)

import { createMcpHandler } from "mcp-handler"
import { z } from "zod"
import getPrisma from "@/lib/db"
import { validateMcpAuth } from "@/lib/mcp-auth"
import {
  getFeedbackItem,
  updateFeedbackStatus,
  linkFeedbackToOpportunity,
  updateFeedbackType,
  promoteFeedbackToRoadmap,
} from "@/lib/feedback-tool-handlers"
import {
  listDocs,
  getDoc,
  createDoc,
  updateDoc,
} from "@/lib/doc-tool-handlers"

const _handler = createMcpHandler(
  (server) => {

    // ════════════════════════════════════════════════════════════════
    // WORKSPACE
    // ════════════════════════════════════════════════════════════════

    server.registerTool(
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
    server.registerTool(
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
        const prisma = getPrisma()
        const org = await prisma.organization.findUnique({
          where: { slug: orgSlug },
          select: {
            id: true,
            name: true,
            workspaces: {
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
    // create_workspace — creates a new workspace inside an organization
    // ----------------------------------------------------------------
    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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
                keyResults: { orderBy: { createdAt: "asc" } },
                squad: { select: { name: true } },
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
          if (obj.parentKeyResultId) lines.push(`Supports KR: ${obj.parentKeyResultId}`)
          for (const kr of obj.keyResults) {
            const pct = kr.target > 0 ? ((kr.current / kr.target) * 100).toFixed(0) : "—"
            lines.push(`  • ${kr.title}: ${kr.current}/${kr.target}${kr.unit ? " " + kr.unit : ""} (${pct}%) — KR ID: ${kr.id}`)
          }
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      }
    )

    server.registerTool(
      "create_objective",
      {
        title: "Create Objective",
        description: "Creates a new Objective inside an OKR cycle. Optionally assign a squad or link to a parent KR (for squad objectives that support a company KR).",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          cycleId: z.string().uuid().describe("UUID of the OKR cycle"),
          title: z.string().min(1).describe("Short title for the objective"),
          description: z.string().optional().describe("Longer description"),
          owner: z.string().optional().describe("Name or email of the accountable owner"),
          squadId: z.string().uuid().optional().describe("UUID of the squad this objective belongs to"),
          parentKeyResultId: z.string().uuid().optional().describe("UUID of a company-level KR this squad objective is supporting"),
        },
      },
      async ({ workspaceId, cycleId, title, description, owner, squadId, parentKeyResultId }) => {
        const prisma = getPrisma()
        const cycle = await prisma.oKRCycle.findFirst({ where: { id: cycleId, workspaceId }, select: { id: true, title: true } })
        if (!cycle) {
          return { content: [{ type: "text" as const, text: `OKR cycle "${cycleId}" not found in workspace.` }] }
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
      "set_objective_parent_kr",
      {
        title: "Set Objective Parent KR",
        description: "Links a squad objective to a company-level Key Result it is supporting. Pass null keyResultId to clear the link.",
        inputSchema: {
          objectiveId: z.string().uuid().describe("UUID of the objective"),
          keyResultId: z.string().uuid().nullable().describe("UUID of the company KR to support, or null to clear"),
        },
      },
      async ({ objectiveId, keyResultId }) => {
        const prisma = getPrisma()
        await prisma.objective.update({ where: { id: objectiveId }, data: { parentKeyResultId: keyResultId } })
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
      "promote_to_roadmap",
      {
        title: "Promote Solution to Roadmap",
        description: "Promotes a validated Solution directly to the roadmap, creating a Roadmap Item with the solution's title and linking back to the originating opportunity.",
        inputSchema: {
          solutionId: z.string().uuid().describe("UUID of the solution to promote"),
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          horizon: z.enum(["NOW", "NEXT", "LATER", "SHIPPED"]).describe("Which roadmap horizon to place this in"),
        },
      },
      async ({ solutionId, workspaceId, horizon }) => {
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
          },
        })
        return {
          content: [{
            type: "text" as const,
            text: `**Promoted to roadmap (${horizon})**\nRoadmap Item ID: ${item.id}\nTitle: ${item.title}\nLinked Solution: ${solutionId}\nLinked Opportunity: ${solution.opportunity.title}`,
          }],
        }
      }
    )

    // ════════════════════════════════════════════════════════════════
    // EXPERIMENTS
    // ════════════════════════════════════════════════════════════════

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
      "list_roadmap_items",
      {
        title: "List Roadmap Items",
        description:
          "Lists all active roadmap items for a workspace grouped by horizon (NOW / NEXT / LATER). " +
          "Includes linked opportunity and solution titles, squad, and IDs.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          horizon: z.enum(["NOW", "NEXT", "LATER", "SHIPPED"]).optional().describe("Filter to a specific horizon (omit for all)"),
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
        const groups: Record<string, typeof items> = { NOW: [], NEXT: [], LATER: [] }
        for (const item of items) {
          groups[item.horizon] ??= []
          groups[item.horizon].push(item)
        }
        const sections = (["NOW", "NEXT", "LATER", "SHIPPED"] as const)
          .filter(h => groups[h]?.length)
          .map(h => {
            const lines = groups[h].map(item =>
              `  • **${item.title}**\n    ID: ${item.id}` +
              (item.opportunity ? `\n    Opportunity: ${item.opportunity.title}` : "") +
              (item.solution ? `\n    Solution: ${item.solution.title}` : "") +
              (item.experiment ? `\n    Experiment: ${item.experiment.title}` : "") +
              (item.squad ? `\n    Squad: ${item.squad.name}` : "")
            )
            return `**${h}**\n${lines.join("\n")}`
          })
        return { content: [{ type: "text" as const, text: sections.join("\n\n") }] }
      }
    )

    server.registerTool(
      "update_roadmap_item",
      {
        title: "Update Roadmap Item",
        description:
          "Updates an existing roadmap item's horizon, status, title, or description. " +
          "Use horizon to move items between NOW / NEXT / LATER. Use status ARCHIVED to remove from view.",
        inputSchema: {
          itemId: z.string().uuid().describe("UUID of the roadmap item"),
          horizon: z.enum(["NOW", "NEXT", "LATER", "SHIPPED"]).optional().describe("Move to a new horizon"),
          status: z.enum(["ACTIVE", "ARCHIVED"]).optional().describe("Set to ARCHIVED to hide from roadmap"),
          title: z.string().min(1).optional().describe("New title for the item"),
          description: z.string().optional().describe("New description"),
        },
      },
      async ({ itemId, horizon, status, title, description }) => {
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
          },
        })
        return {
          content: [{
            type: "text" as const,
            text:
              `**Roadmap item updated**\nID: ${updated.id}\nTitle: ${updated.title}\n` +
              `Horizon: ${updated.horizon}\nStatus: ${updated.status}`,
          }],
        }
      }
    )

    server.registerTool(
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
        },
      },
      async ({ workspaceId, title, horizon, description, solutionId, keyResultId, opportunityId, squadId }) => {
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
          },
        })
        return {
          content: [{
            type: "text" as const,
            text: `**Roadmap item created** (${horizon})\nID: ${item.id}\nTitle: ${item.title}` +
              (solutionId ? `\nLinked Solution: ${solutionId}` : "") +
              (keyResultId ? `\nLinked KR: ${keyResultId}` : "") +
              (opportunityId ? `\nLinked Opportunity: ${opportunityId}` : ""),
          }],
        }
      }
    )

    // ════════════════════════════════════════════════════════════════
    // SQUADS
    // ════════════════════════════════════════════════════════════════

    server.registerTool(
      "list_squads",
      {
        title: "List Squads",
        description: "Lists all squads in a workspace with their IDs and colors.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
        },
      },
      async ({ workspaceId }) => {
        const prisma = getPrisma()
        const squads = await prisma.squad.findMany({
          where: { workspaceId },
          orderBy: { createdAt: "asc" },
        })
        if (!squads.length) {
          return { content: [{ type: "text" as const, text: "No squads in this workspace." }] }
        }
        const lines = squads.map(s => `• **${s.name}** (${s.color}) — ID: ${s.id}`)
        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      }
    )

    server.registerTool(
      "assign_squad",
      {
        title: "Assign Squad",
        description: "Assigns a Squad to any object: opportunity, experiment, roadmap_item, or objective. Pass null squadId to clear.",
        inputSchema: {
          objectType: z.enum(["opportunity", "experiment", "roadmap_item", "objective"]).describe("Type of object to assign the squad to"),
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
    // FEEDBACK
    // ════════════════════════════════════════════════════════════════

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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
        },
      },
      promoteFeedbackToRoadmap
    )

    // ════════════════════════════════════════════════════════════════
    // DOCS
    // ════════════════════════════════════════════════════════════════

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
      "create_doc",
      {
        title: "Create Doc",
        description:
          "Creates a new doc in a workspace. Optionally nest it under a parent doc. " +
          "Content should be markdown. Returns the new doc ID and the docs URL.",
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
        },
      },
      createDoc
    )

    server.registerTool(
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
  return _handler(req)
}

export async function GET(req: Request) { return withMcpAuth(req) }
export async function POST(req: Request) { return withMcpAuth(req) }
