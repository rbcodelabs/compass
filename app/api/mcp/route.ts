// MCP_API_KEY — set this environment variable in your Vercel project settings
// and in .env.local for local development. All MCP requests require:
//   Authorization: Bearer <MCP_API_KEY>
//
// basePath: "/api" → streamableHttpEndpoint resolves to "/api/mcp",
// which matches this Next.js route's path.
// disableSse: true — only the modern Streamable HTTP transport is exposed.

import { createMcpHandler } from "mcp-handler"
import { z } from "zod"
import getPrisma from "@/lib/db"
import { validateMcpAuth } from "@/lib/mcp-auth"

const _handler = createMcpHandler(
  (server) => {
    // ----------------------------------------------------------------
    // get_workspace_summary — overview counts for a workspace
    // ----------------------------------------------------------------
    server.registerTool(
      "get_workspace_summary",
      {
        title: "Get Workspace Summary",
        description:
          "Returns high-level counts and status for a workspace: name, OKR cycles, " +
          "opportunities, experiments, roadmap items, active experiments, and the active OKR cycle.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
        },
      },
      async ({ workspaceId }) => {
        const prisma = await getPrisma()

        const [workspace, okrCycleCount, opportunityCount, experimentCount, roadmapItemCount, activeExperiments, activeOKRCycle] =
          await Promise.all([
            prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
            prisma.oKRCycle.count({ where: { workspaceId } }),
            prisma.opportunity.count({ where: { workspaceId } }),
            prisma.experiment.count({ where: { workspaceId } }),
            prisma.roadmapItem.count({ where: { workspaceId } }),
            prisma.experiment.count({ where: { workspaceId, status: "RUNNING" } }),
            prisma.oKRCycle.findFirst({
              where: { workspaceId, status: "ACTIVE" },
              select: { id: true, title: true, startDate: true, endDate: true, status: true },
            }),
          ])

        if (!workspace) {
          return {
            content: [{ type: "text" as const, text: `No workspace found with id "${workspaceId}".` }],
          }
        }

        const cycleText = activeOKRCycle
          ? `${activeOKRCycle.title} (${activeOKRCycle.startDate.toLocaleDateString()} – ${activeOKRCycle.endDate.toLocaleDateString()})`
          : "None"

        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Workspace:** ${workspace.name}\n\n` +
                `**OKR Cycles:** ${okrCycleCount}\n` +
                `**Opportunities:** ${opportunityCount}\n` +
                `**Experiments:** ${experimentCount} (${activeExperiments} running)\n` +
                `**Roadmap Items:** ${roadmapItemCount}\n` +
                `**Active OKR Cycle:** ${cycleText}`,
            },
          ],
        }
      }
    )

    // ----------------------------------------------------------------
    // create_objective — add an objective to an OKR cycle
    // ----------------------------------------------------------------
    server.registerTool(
      "create_objective",
      {
        title: "Create Objective",
        description: "Creates a new Objective inside an OKR cycle. Returns the created objective.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace (used to verify cycle ownership)"),
          cycleId: z.string().uuid().describe("UUID of the OKR cycle to attach this objective to"),
          title: z.string().min(1).describe("Short title for the objective"),
          description: z.string().optional().describe("Longer description of the objective"),
          owner: z.string().optional().describe("Name or email of the person accountable for this objective"),
        },
      },
      async ({ workspaceId, cycleId, title, description, owner }) => {
        const prisma = await getPrisma()

        // Verify cycle belongs to the workspace
        const cycle = await prisma.oKRCycle.findFirst({
          where: { id: cycleId, workspaceId },
          select: { id: true, title: true },
        })
        if (!cycle) {
          return {
            content: [
              {
                type: "text" as const,
                text: `OKR cycle "${cycleId}" not found in workspace "${workspaceId}".`,
              },
            ],
          }
        }

        const objective = await prisma.objective.create({
          data: {
            cycleId,
            title: title.trim(),
            description: description?.trim(),
            owner: owner?.trim(),
          },
        })

        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Objective created** in cycle "${cycle.title}"\n\n` +
                `**ID:** ${objective.id}\n` +
                `**Title:** ${objective.title}\n` +
                `**Owner:** ${objective.owner ?? "—"}\n` +
                `**Status:** ${objective.status}`,
            },
          ],
        }
      }
    )

    // ----------------------------------------------------------------
    // add_key_result — attach a key result to an objective
    // ----------------------------------------------------------------
    server.registerTool(
      "add_key_result",
      {
        title: "Add Key Result",
        description: "Adds a Key Result to an existing Objective. Returns the created key result.",
        inputSchema: {
          objectiveId: z.string().uuid().describe("UUID of the parent objective"),
          title: z.string().min(1).describe("Title describing what will be measured"),
          target: z.number().describe("Numeric target value (e.g. 100 for 100%)"),
          unit: z.string().optional().describe("Unit label, e.g. '%', 'users', 'NPS points'"),
        },
      },
      async ({ objectiveId, title, target, unit }) => {
        const prisma = await getPrisma()

        const objective = await prisma.objective.findUnique({
          where: { id: objectiveId },
          select: { id: true, title: true },
        })
        if (!objective) {
          return {
            content: [{ type: "text" as const, text: `Objective "${objectiveId}" not found.` }],
          }
        }

        const keyResult = await prisma.keyResult.create({
          data: {
            objectiveId,
            title: title.trim(),
            target,
            unit: unit?.trim(),
          },
        })

        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Key Result created** on objective "${objective.title}"\n\n` +
                `**ID:** ${keyResult.id}\n` +
                `**Title:** ${keyResult.title}\n` +
                `**Target:** ${keyResult.target}${keyResult.unit ? " " + keyResult.unit : ""}\n` +
                `**Current:** ${keyResult.current}`,
            },
          ],
        }
      }
    )

    // ----------------------------------------------------------------
    // log_checkin — record progress against a key result
    // ----------------------------------------------------------------
    server.registerTool(
      "log_checkin",
      {
        title: "Log Check-In",
        description:
          "Records a progress check-in for a Key Result and updates its current value. Returns the updated Key Result.",
        inputSchema: {
          keyResultId: z.string().uuid().describe("UUID of the key result to update"),
          value: z.number().describe("New current value to record"),
          note: z.string().optional().describe("Optional context note about this check-in"),
        },
      },
      async ({ keyResultId, value, note }) => {
        const prisma = await getPrisma()

        const existing = await prisma.keyResult.findUnique({
          where: { id: keyResultId },
          select: { id: true, title: true },
        })
        if (!existing) {
          return {
            content: [{ type: "text" as const, text: `Key Result "${keyResultId}" not found.` }],
          }
        }

        // Create check-in and update current value in parallel
        const [, keyResult] = await Promise.all([
          prisma.checkIn.create({
            data: { keyResultId, value, note: note?.trim() },
          }),
          prisma.keyResult.update({
            where: { id: keyResultId },
            data: { current: value },
          }),
        ])

        const pct = keyResult.target > 0 ? ((keyResult.current / keyResult.target) * 100).toFixed(1) : "N/A"

        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Check-in logged** for "${keyResult.title}"\n\n` +
                `**Current:** ${keyResult.current}${keyResult.unit ? " " + keyResult.unit : ""} / ` +
                `${keyResult.target}${keyResult.unit ? " " + keyResult.unit : ""} (${pct}%)` +
                (note ? `\n**Note:** ${note}` : ""),
            },
          ],
        }
      }
    )

    // ----------------------------------------------------------------
    // create_opportunity — add an opportunity to the workspace
    // ----------------------------------------------------------------
    server.registerTool(
      "create_opportunity",
      {
        title: "Create Opportunity",
        description:
          "Creates a new customer or product Opportunity in the workspace. Returns the created opportunity.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          title: z.string().min(1).describe("Short title for the opportunity"),
          description: z.string().optional().describe("What problem or need this opportunity represents"),
          customerSegment: z.string().optional().describe("The customer segment this opportunity affects"),
          status: z
            .enum(["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "ARCHIVED"])
            .optional()
            .default("EXPLORING")
            .describe("Initial status (defaults to EXPLORING)"),
        },
      },
      async ({ workspaceId, title, description, customerSegment, status }) => {
        const prisma = await getPrisma()

        const workspace = await prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { name: true },
        })
        if (!workspace) {
          return {
            content: [{ type: "text" as const, text: `Workspace "${workspaceId}" not found.` }],
          }
        }

        const opportunity = await prisma.opportunity.create({
          data: {
            workspaceId,
            title: title.trim(),
            description: description?.trim(),
            customerSegment: customerSegment?.trim(),
            status: status ?? "EXPLORING",
          },
        })

        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Opportunity created** in "${workspace.name}"\n\n` +
                `**ID:** ${opportunity.id}\n` +
                `**Title:** ${opportunity.title}\n` +
                `**Segment:** ${opportunity.customerSegment ?? "—"}\n` +
                `**Status:** ${opportunity.status}`,
            },
          ],
        }
      }
    )

    // ----------------------------------------------------------------
    // add_solution — attach a solution to an opportunity
    // ----------------------------------------------------------------
    server.registerTool(
      "add_solution",
      {
        title: "Add Solution",
        description: "Adds a proposed Solution to an Opportunity. Returns the created solution.",
        inputSchema: {
          opportunityId: z.string().uuid().describe("UUID of the parent opportunity"),
          title: z.string().min(1).describe("Title of the proposed solution"),
          description: z.string().optional().describe("How this solution addresses the opportunity"),
        },
      },
      async ({ opportunityId, title, description }) => {
        const prisma = await getPrisma()

        const opportunity = await prisma.opportunity.findUnique({
          where: { id: opportunityId },
          select: { id: true, title: true },
        })
        if (!opportunity) {
          return {
            content: [{ type: "text" as const, text: `Opportunity "${opportunityId}" not found.` }],
          }
        }

        const solution = await prisma.solution.create({
          data: {
            opportunityId,
            title: title.trim(),
            description: description?.trim(),
          },
        })

        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Solution created** for opportunity "${opportunity.title}"\n\n` +
                `**ID:** ${solution.id}\n` +
                `**Title:** ${solution.title}\n` +
                `**Status:** ${solution.status}`,
            },
          ],
        }
      }
    )

    // ----------------------------------------------------------------
    // create_experiment — design a new experiment
    // ----------------------------------------------------------------
    server.registerTool(
      "create_experiment",
      {
        title: "Create Experiment",
        description:
          "Creates a new Experiment in DESIGNING status. Optionally links it to an Assumption. Returns the created experiment.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          title: z.string().min(1).describe("Short name for the experiment"),
          hypothesis: z.string().min(1).describe("What you believe to be true and are testing"),
          method: z.string().min(1).describe("How you will run the experiment"),
          killCondition: z
            .string()
            .min(1)
            .describe("The condition or threshold that means the hypothesis is false"),
          assumptionId: z
            .string()
            .uuid()
            .optional()
            .describe("UUID of the Assumption this experiment is testing (optional)"),
        },
      },
      async ({ workspaceId, title, hypothesis, method, killCondition, assumptionId }) => {
        const prisma = await getPrisma()

        const workspace = await prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { name: true },
        })
        if (!workspace) {
          return {
            content: [{ type: "text" as const, text: `Workspace "${workspaceId}" not found.` }],
          }
        }

        if (assumptionId) {
          const assumption = await prisma.assumption.findUnique({ where: { id: assumptionId } })
          if (!assumption) {
            return {
              content: [{ type: "text" as const, text: `Assumption "${assumptionId}" not found.` }],
            }
          }
        }

        const experiment = await prisma.experiment.create({
          data: {
            workspaceId,
            title: title.trim(),
            hypothesis: hypothesis.trim(),
            method: method.trim(),
            killCondition: killCondition.trim(),
            assumptionId: assumptionId ?? null,
            status: "DESIGNING",
          },
        })

        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Experiment created** in "${workspace.name}"\n\n` +
                `**ID:** ${experiment.id}\n` +
                `**Title:** ${experiment.title}\n` +
                `**Status:** ${experiment.status}\n` +
                `**Hypothesis:** ${experiment.hypothesis}\n` +
                `**Kill Condition:** ${experiment.killCondition}`,
            },
          ],
        }
      }
    )

    // ----------------------------------------------------------------
    // log_experiment_result — record a result observation
    // ----------------------------------------------------------------
    server.registerTool(
      "log_experiment_result",
      {
        title: "Log Experiment Result",
        description: "Records an observation or data point for a running experiment. Returns the created result.",
        inputSchema: {
          experimentId: z.string().uuid().describe("UUID of the experiment"),
          note: z.string().min(1).describe("Description of what was observed"),
          metric: z.string().optional().describe("Name of the metric being recorded (e.g. 'conversion rate')"),
          value: z.number().optional().describe("Numeric value for the metric"),
        },
      },
      async ({ experimentId, note, metric, value }) => {
        const prisma = await getPrisma()

        const experiment = await prisma.experiment.findUnique({
          where: { id: experimentId },
          select: { id: true, title: true },
        })
        if (!experiment) {
          return {
            content: [{ type: "text" as const, text: `Experiment "${experimentId}" not found.` }],
          }
        }

        const result = await prisma.experimentResult.create({
          data: {
            experimentId,
            note: note.trim(),
            metric: metric?.trim(),
            value: value ?? null,
          },
        })

        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Result logged** for experiment "${experiment.title}"\n\n` +
                `**ID:** ${result.id}\n` +
                `**Note:** ${result.note}` +
                (result.metric ? `\n**Metric:** ${result.metric}` : "") +
                (result.value != null ? ` = ${result.value}` : ""),
            },
          ],
        }
      }
    )

    // ----------------------------------------------------------------
    // add_to_roadmap — place an item on the roadmap
    // ----------------------------------------------------------------
    server.registerTool(
      "add_to_roadmap",
      {
        title: "Add to Roadmap",
        description:
          "Creates a Roadmap Item in the NOW, NEXT, or LATER horizon. Optionally links to a Solution or Key Result. Returns the created item.",
        inputSchema: {
          workspaceId: z.string().uuid().describe("UUID of the workspace"),
          title: z.string().min(1).describe("Title of the roadmap item"),
          horizon: z.enum(["NOW", "NEXT", "LATER"]).describe("Which horizon to place this item in"),
          description: z.string().optional().describe("Additional context for the roadmap item"),
          solutionId: z.string().uuid().optional().describe("UUID of a Solution to link (optional)"),
          keyResultId: z.string().uuid().optional().describe("UUID of a Key Result to link (optional)"),
        },
      },
      async ({ workspaceId, title, horizon, description, solutionId, keyResultId }) => {
        const prisma = await getPrisma()

        const workspace = await prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { name: true },
        })
        if (!workspace) {
          return {
            content: [{ type: "text" as const, text: `Workspace "${workspaceId}" not found.` }],
          }
        }

        if (solutionId) {
          const solution = await prisma.solution.findUnique({ where: { id: solutionId } })
          if (!solution) {
            return {
              content: [{ type: "text" as const, text: `Solution "${solutionId}" not found.` }],
            }
          }
        }

        if (keyResultId) {
          const kr = await prisma.keyResult.findUnique({ where: { id: keyResultId } })
          if (!kr) {
            return {
              content: [{ type: "text" as const, text: `Key Result "${keyResultId}" not found.` }],
            }
          }
        }

        const item = await prisma.roadmapItem.create({
          data: {
            workspaceId,
            title: title.trim(),
            horizon,
            description: description?.trim(),
            solutionId: solutionId ?? null,
            keyResultId: keyResultId ?? null,
          },
        })

        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Roadmap item created** in "${workspace.name}"\n\n` +
                `**ID:** ${item.id}\n` +
                `**Title:** ${item.title}\n` +
                `**Horizon:** ${item.horizon}\n` +
                `**Status:** ${item.status}` +
                (solutionId ? `\n**Linked Solution:** ${solutionId}` : "") +
                (keyResultId ? `\n**Linked Key Result:** ${keyResultId}` : ""),
            },
          ],
        }
      }
    )
  },
  {},
  {
    basePath: "/api",
    disableSse: true,
    maxDuration: 60,
  }
)

// Wrap the raw handler with Bearer-token auth so unauthenticated
// requests are rejected before any MCP processing happens.
async function withMcpAuth(req: Request): Promise<Response> {
  if (!validateMcpAuth(req)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    })
  }
  return _handler(req)
}

export async function GET(req: Request) {
  return withMcpAuth(req)
}

export async function POST(req: Request) {
  return withMcpAuth(req)
}
