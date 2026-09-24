import { randomUUID } from "node:crypto";
import type { AppPrismaClient } from "./db";
import {
  retryUpdatesTransaction,
  workspaceUpdatesAvailable,
} from "./workspace-updates-capture";
import {
  readUpdatesToken,
  signUpdatesToken,
  type UpdatesToken,
} from "./workspace-updates-token";
import { resolveUpdateSources } from "./workspace-updates-sources";
import type { UpdateItem } from "./workspace-updates-model";

export interface UpdatesPage {
  available: boolean;
  items: UpdateItem[];
  cursor: string | null;
  markToken: string | null;
  readRevision: number;
  snapshotRevision: number;
}
const PAGE_SIZE = 100;
export async function getUpdatesPage(
  prisma: AppPrismaClient,
  workspaceId: string,
  userId: string,
  base: string,
  mode: "unread" | "week",
  cursor?: string,
): Promise<UpdatesPage> {
  if (!(await workspaceUpdatesAvailable(prisma)))
    return {
      available: false,
      items: [],
      cursor: null,
      markToken: null,
      readRevision: 0,
      snapshotRevision: 0,
    };
  const requested = cursor
    ? readUpdatesToken(cursor, workspaceId, userId)
    : null;
  if (requested && (requested.mode !== mode || requested.complete))
    throw new Error("Invalid continuation");
  return retryUpdatesTransaction(prisma, async (tx) => {
    let state = await tx.workspaceUpdatesReadState.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!state)
      state = await tx.workspaceUpdatesReadState.create({
        data: {
          workspaceId,
          userId,
          version: randomUUID(),
          baselineAt: new Date(Date.now() - 7 * 86400000),
        },
      });
    const counter = await tx.workspaceUpdatesState.findUnique({
      where: { workspaceId },
    });
    const upper = requested?.upper ?? counter?.revision ?? 0;
    const baseline =
      requested?.baseline ??
      (mode === "week"
        ? new Date(Date.now() - 7 * 86400000)
        : state.baselineAt
      ).toISOString();
    const readRevision = requested?.readRevision ?? state.caughtUpRevision;
    const rows = await tx.workspaceUpdateEvent.findMany({
      where: {
        workspaceId,
        revision: {
          lte: upper,
          lt: requested?.before,
          gt: mode === "unread" ? readRevision : undefined,
        },
        createdAt: { gte: new Date(baseline) },
      },
      orderBy: { revision: "desc" },
      take: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    const more = rows.length > PAGE_SIZE;
    const token: UpdatesToken = {
      workspaceId,
      userId,
      upper,
      before: page.at(-1)?.revision ?? 0,
      mode,
      baseline,
      readRevision,
      complete: !more,
    };
    return {
      available: true,
      items: await resolveUpdateSources(tx, workspaceId, page, base),
      cursor: more ? signUpdatesToken(token) : null,
      markToken: !more && mode === "unread" ? signUpdatesToken(token) : null,
      readRevision: state.caughtUpRevision,
      snapshotRevision: upper,
    };
  });
}

export async function markUpdatesCaughtUp(
  prisma: AppPrismaClient,
  workspaceId: string,
  userId: string,
  token: string,
) {
  const snapshot = readUpdatesToken(token, workspaceId, userId);
  if (!snapshot.complete || snapshot.mode !== "unread")
    throw new Error("Load all unread updates before marking caught up");
  if (!(await workspaceUpdatesAvailable(prisma)))
    throw new Error("Updates is not available");
  return retryUpdatesTransaction(prisma, async (tx) => {
    const state = await tx.workspaceUpdatesReadState.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    const counter = await tx.workspaceUpdatesState.findUnique({
      where: { workspaceId },
    });
    if (!state || snapshot.upper > (counter?.revision ?? 0))
      throw new Error("Invalid snapshot");
    if (state.caughtUpRevision < snapshot.readRevision)
      throw new Error(
        "Catch-up changed in another tab. Refresh to load all unread updates.",
      );
    const version = randomUUID();
    const result = await tx.workspaceUpdatesReadState.updateMany({
      where: { id: state.id, version: state.version },
      data: {
        previousRevision: state.caughtUpRevision,
        caughtUpRevision: Math.max(state.caughtUpRevision, snapshot.upper),
        version,
      },
    });
    if (result.count !== 1)
      throw new Error(
        "Catch-up changed in another tab. Refresh and try again.",
      );
    return {
      receipt: version,
      readRevision: Math.max(state.caughtUpRevision, snapshot.upper),
    };
  });
}

export async function undoUpdatesCaughtUp(
  prisma: AppPrismaClient,
  workspaceId: string,
  userId: string,
  receipt: string,
) {
  if (!/^[0-9a-f-]{36}$/i.test(receipt)) throw new Error("Invalid receipt");
  if (!(await workspaceUpdatesAvailable(prisma)))
    throw new Error("Updates is not available");
  return retryUpdatesTransaction(prisma, async (tx) => {
    const state = await tx.workspaceUpdatesReadState.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!state || state.version !== receipt || state.previousRevision === null)
      throw new Error(
        "Catch-up changed in another tab. Refresh to see your latest updates.",
      );
    const result = await tx.workspaceUpdatesReadState.updateMany({
      where: { id: state.id, version: receipt },
      data: {
        caughtUpRevision: state.previousRevision,
        previousRevision: null,
        version: randomUUID(),
      },
    });
    if (result.count !== 1)
      throw new Error(
        "Catch-up changed in another tab. Refresh to see your latest updates.",
      );
    return { readRevision: state.previousRevision };
  });
}
