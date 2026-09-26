import type { AppTransactionClient } from "./db";
import type { WorkspaceUpdateEvent } from "@prisma/client";
import type { UpdateItem } from "./workspace-updates-model";

type Source = { title: string; path: string };
export async function resolveUpdateSources(
  tx: AppTransactionClient,
  workspaceId: string,
  events: WorkspaceUpdateEvent[],
  base: string,
): Promise<UpdateItem[]> {
  const comments = await tx.comment.findMany({
    where: {
      workspaceId,
      id: {
        in: events
          .filter((e) => e.entityType === "COMMENT")
          .map((e) => e.entityId),
      },
    },
    select: { id: true, targetId: true, targetType: true },
  });
  const evidence = await tx.evidence.findMany({
    where: {
      workspaceId,
      id: {
        in: events
          .filter((e) => e.entityType === "EVIDENCE")
          .map((e) => e.entityId),
      },
    },
    select: {
      id: true,
      opportunityId: true,
      solutionId: true,
      assumptionId: true,
    },
  });
  const related = comments
    .map((c) => ({
      type: c.targetType === "REVIEW_REQUEST" ? "DECISION" : c.targetType,
      id: c.targetId,
    }))
    .concat(
      evidence.flatMap((e) =>
        e.opportunityId
          ? [{ type: "OPPORTUNITY", id: e.opportunityId }]
          : e.solutionId
            ? [{ type: "SOLUTION", id: e.solutionId }]
            : e.assumptionId
              ? [{ type: "ASSUMPTION", id: e.assumptionId }]
              : [],
      ),
    );
  const ids = (type: string) => [
    ...new Set([
      ...events
        .flatMap((e) => [
          e.entityType === type ? e.entityId : [],
          e.groupType === type ? e.groupId : [],
        ])
        .flat(),
      ...related.filter((r) => r.type === type).map((r) => r.id),
    ]),
  ];
  const sources = new Map<string, Source>();
  const put = (type: string, id: string, title: string, path: string) =>
    sources.set(`${type}:${id}`, { title, path: `${base}/${path}` });
  await Promise.all([
    tx.task
      .findMany({
        where: { workspaceId, id: { in: ids("TASK") } },
        select: { id: true, title: true, parentTaskId: true },
      })
      .then(async (rows) => {
        const parents = await tx.task.findMany({
          where: {
            workspaceId,
            id: {
              in: rows.flatMap((r) => (r.parentTaskId ? [r.parentTaskId] : [])),
            },
          },
          select: { id: true },
        });
        const live = new Set(parents.map((r) => r.id));
        for (const r of rows)
          if (!r.parentTaskId || live.has(r.parentTaskId))
            put("TASK", r.id, r.title, `tasks/${r.id}`);
      }),
    tx.opportunity
      .findMany({
        where: { workspaceId, id: { in: ids("OPPORTUNITY") } },
        select: { id: true, title: true },
      })
      .then((rows) => {
        for (const r of rows)
          put("OPPORTUNITY", r.id, r.title, `discovery/${r.id}`);
      }),
    tx.solution
      .findMany({
        where: { id: { in: ids("SOLUTION") }, opportunity: { workspaceId } },
        select: { id: true, title: true, opportunityId: true },
      })
      .then((rows) => {
        for (const r of rows)
          put(
            "SOLUTION",
            r.id,
            r.title,
            `discovery/${r.opportunityId}?detail=solution%3A${r.id}`,
          );
      }),
    tx.assumption
      .findMany({
        where: {
          id: { in: ids("ASSUMPTION") },
          solution: { opportunity: { workspaceId } },
        },
        select: {
          id: true,
          title: true,
          solutionId: true,
          solution: { select: { opportunityId: true } },
        },
      })
      .then((rows) => {
        for (const r of rows)
          put(
            "ASSUMPTION",
            r.id,
            r.title,
            `discovery/${r.solution.opportunityId}?detail=assumption%3A${r.id}`,
          );
      }),
    tx.roadmapItem
      .findMany({
        where: { workspaceId, id: { in: ids("ROADMAP_ITEM") } },
        select: { id: true, title: true },
      })
      .then((rows) => {
        for (const r of rows)
          put(
            "ROADMAP_ITEM",
            r.id,
            r.title,
            `roadmap?detail=roadmapItem%3A${r.id}`,
          );
      }),
    tx.experiment
      .findMany({
        where: { workspaceId, id: { in: ids("EXPERIMENT") } },
        select: { id: true, title: true },
      })
      .then((rows) => {
        for (const r of rows)
          put("EXPERIMENT", r.id, r.title, `experiments/${r.id}`);
      }),
    tx.reviewRequest
      .findMany({
        where: { workspaceId, id: { in: ids("DECISION") } },
        select: { id: true, currentRevision: { select: { title: true } } },
      })
      .then((rows) => {
        for (const r of rows)
          if (r.currentRevision)
            put("DECISION", r.id, r.currentRevision.title, `reviews/${r.id}`);
      }),
    tx.doc
      .findMany({
        where: { workspaceId, id: { in: ids("DOC") } },
        select: { id: true, title: true },
      })
      .then((rows) => {
        for (const r of rows) put("DOC", r.id, r.title, `docs/${r.id}`);
      }),
  ]);
  for (const c of comments) {
    const source = sources.get(
      `${c.targetType === "REVIEW_REQUEST" ? "DECISION" : c.targetType}:${c.targetId}`,
    );
    if (source) sources.set(`COMMENT:${c.id}`, source);
  }
  for (const e of evidence) {
    const key = e.opportunityId
      ? `OPPORTUNITY:${e.opportunityId}`
      : e.solutionId
        ? `SOLUTION:${e.solutionId}`
        : `ASSUMPTION:${e.assumptionId}`;
    const source = sources.get(key);
    if (source) sources.set(`EVIDENCE:${e.id}`, source);
  }
  const users = await tx.user.findMany({
    where: {
      id: {
        in: events
          .filter((e) => e.actorType === "USER" && e.actorId)
          .map((e) => e.actorId!),
      },
    },
    select: { id: true, name: true },
  });
  const agents = await tx.agent.findMany({
    where: {
      id: {
        in: events
          .filter((e) => e.actorType === "AGENT" && e.actorId)
          .map((e) => e.actorId!),
      },
    },
    select: { id: true, name: true },
  });
  const names = new Map([...users, ...agents].map((u) => [u.id, u.name]));
  return events.flatMap((e) => {
    const source = sources.get(`${e.entityType}:${e.entityId}`);
    if (!source) return [];
    const explicitGroup = sources.get(`${e.groupType}:${e.groupId}`);
    const group = explicitGroup ?? source;
    return [
      {
        ...e,
        groupType: explicitGroup ? e.groupType : e.entityType,
        groupId: explicitGroup ? e.groupId : e.entityId,
        title: source.title,
        href: source.path,
        groupTitle: group.title,
        groupHref: group.path,
        actor:
          (e.actorId && names.get(e.actorId)) ||
          (e.actorType === "AGENT"
            ? "An agent"
            : e.actorType === "USER"
              ? "A teammate"
              : "Compass"),
        createdAt: e.createdAt.toISOString(),
      },
    ];
  });
}
