import { NextResponse } from "next/server";
import getPrisma from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace-context";
import { parseCustomFieldFilterParams, resolveCustomFieldFilter } from "@/lib/custom-field-filter";
import { resolveWorkspaceScoringModel } from "@/lib/scoring-model";
import { toScoreSummary } from "@/lib/score-summary";
import { buildOpportunityCsv, type OpportunityExportRow } from "@/lib/opportunity-export";
import { csvDownloadResponse, csvFilenameStem } from "@/lib/csv";

/**
 * CSV export of the Discovery page's opportunities.
 *
 * Takes the same filter params the page does (`squad`, `field`, `fieldValue`) so
 * "export" means "what I am looking at", not "everything". The two queries and
 * the filter resolution mirror app/[orgSlug]/[workspaceSlug]/discovery/page.tsx;
 * if that page's filtering changes, change it here too.
 *
 * Board status order (active statuses, then archived) matches the page, with the
 * Status column kept in the file so archived rows can be filtered out in a sheet.
 */
const STATUS_ORDER = ["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "ARCHIVED"] as const;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const orgSlug = searchParams.get("orgSlug");
  const workspaceSlug = searchParams.get("workspaceSlug");
  if (!orgSlug || !workspaceSlug) {
    return NextResponse.json({ error: "Missing orgSlug or workspaceSlug" }, { status: 400 });
  }

  // Session AND membership in one lookup; non-members get the same 404 as a
  // missing workspace, so the export cannot be used to probe other tenants.
  const context = await getWorkspaceContext(orgSlug, workspaceSlug);
  if (context.status === "unauthenticated") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (context.status === "not-found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const workspace = context.workspace;
  const prisma = getPrisma();

  const squadFilter = searchParams.get("squad") || undefined;
  const customFieldFilter = await resolveCustomFieldFilter(prisma, {
    workspaceId: workspace.id,
    objectTypes: ["OPPORTUNITY", "SOLUTION"],
    filter: parseCustomFieldFilterParams({
      field: searchParams.get("field") ?? undefined,
      fieldValue: searchParams.get("fieldValue") ?? undefined,
    }),
  });
  const opportunityIdFilter =
    customFieldFilter?.objectType === "OPPORTUNITY" ? { id: { in: customFieldFilter.objectIds } } : {};
  // A Solution-level tag narrows the Solutions column only, as in the table view.
  const solutionIdFilter =
    customFieldFilter?.objectType === "SOLUTION" ? new Set(customFieldFilter.objectIds) : null;

  const [opportunities, squads, scoringModel] = await Promise.all([
    prisma.opportunity.findMany({
      where: {
        workspaceId: workspace.id,
        ...(squadFilter ? { squadId: squadFilter } : {}),
        ...opportunityIdFilter,
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        customerSegment: true,
        status: true,
        squadId: true,
        score: { select: { normalizedScore: true, modelVersion: true } },
        _count: { select: { evidence: true } },
        // A solution whose own workspaceId is NULL or another workspace's is hidden, not trusted via its parent.
        solutions: { where: { workspaceId: workspace.id }, select: { id: true } },
      },
    }),
    prisma.squad.findMany({ where: { workspaceId: workspace.id }, select: { id: true, name: true } }),
    resolveWorkspaceScoringModel(workspace.id, "OPPORTUNITY"),
  ]);

  const squadName = new Map(squads.map((s) => [s.id, s.name]));
  const rank = (status: string) => {
    const index = STATUS_ORDER.indexOf(status as (typeof STATUS_ORDER)[number]);
    return index === -1 ? STATUS_ORDER.length : index;
  };

  // Array#sort is stable, so within a status the query's manual order survives.
  const rows: OpportunityExportRow[] = [...opportunities]
    .sort((a, b) => rank(a.status) - rank(b.status))
    .map((o) => ({
      id: o.id,
      title: o.title,
      status: o.status,
      customerSegment: o.customerSegment,
      squadName: o.squadId ? (squadName.get(o.squadId) ?? null) : null,
      // null whenever there is no score row *or* no active model, as on the board.
      score: toScoreSummary(o.score, scoringModel)?.normalizedScore ?? null,
      solutionCount: solutionIdFilter
        ? o.solutions.filter((s) => solutionIdFilter.has(s.id)).length
        : o.solutions.length,
      evidenceCount: o._count.evidence,
    }));

  const csv = buildOpportunityCsv(rows, {
    origin: new URL(req.url).origin,
    orgSlug,
    workspaceSlug,
  });
  const date = new Date().toISOString().slice(0, 10);
  return csvDownloadResponse(csv, `${csvFilenameStem(workspace.name, "workspace")}-opportunities-${date}.csv`);
}
