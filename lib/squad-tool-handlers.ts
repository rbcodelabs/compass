/** Handler functions for Squad MCP tools. */

import { revalidatePath } from "next/cache"
import getPrisma from "@/lib/db"

export async function createSquad({
  workspaceId,
  name,
  color,
}: {
  workspaceId: string
  name: string
  color?: string
}) {
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, organization: { select: { slug: true } }, slug: true },
  })
  if (!workspace) {
    return { content: [{ type: "text" as const, text: `No workspace found with id "${workspaceId}".` }] }
  }

  const squad = await prisma.squad.create({
    data: {
      workspaceId,
      name: name.trim(),
      color: color ?? "#6366f1",
      source: "MCP",
    },
  })

  revalidatePath(`/${workspace.organization.slug}/${workspace.slug}`, "layout")

  return {
    content: [{
      type: "text" as const,
      text:
        `**Squad created**\n` +
        `ID: ${squad.id}\n` +
        `Name: ${squad.name}\n` +
        `Color: ${squad.color}`,
    }],
  }
}

export async function listSquads({ workspaceId }: { workspaceId: string }) {
  const prisma = getPrisma()
  const squads = await prisma.squad.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
  })
  if (!squads.length) {
    return { content: [{ type: "text" as const, text: "No squads in this workspace." }] }
  }
  const lines = squads.map((s) => `• **${s.name}** (${s.color}) — ID: ${s.id}`)
  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

export async function getSquad({ squadId }: { squadId: string }) {
  const prisma = getPrisma()
  const squad = await prisma.squad.findUnique({
    where: { id: squadId },
    select: { id: true, workspaceId: true, name: true, color: true },
  })
  if (!squad) {
    return { content: [{ type: "text" as const, text: `Squad "${squadId}" not found.` }] }
  }
  return {
    content: [{
      type: "text" as const,
      text:
        `**Squad:** ${squad.name}\n` +
        `ID: ${squad.id}\n` +
        `Workspace ID: ${squad.workspaceId}\n` +
        `Color: ${squad.color}`,
    }],
  }
}

export async function updateSquad({
  squadId,
  name,
  color,
}: {
  squadId: string
  name?: string
  color?: string
}) {
  const prisma = getPrisma()
  const existing = await prisma.squad.findUnique({
    where: { id: squadId },
    select: {
      id: true,
      workspace: { select: { slug: true, organization: { select: { slug: true } } } },
    },
  })
  if (!existing) {
    return { content: [{ type: "text" as const, text: `Squad "${squadId}" not found.` }] }
  }

  const squad = await prisma.squad.update({
    where: { id: squadId },
    data: {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(color !== undefined ? { color } : {}),
    },
  })

  revalidatePath(`/${existing.workspace.organization.slug}/${existing.workspace.slug}`, "layout")

  return {
    content: [{
      type: "text" as const,
      text:
        `**Squad updated**\n` +
        `ID: ${squad.id}\n` +
        `Name: ${squad.name}\n` +
        `Color: ${squad.color}`,
    }],
  }
}
