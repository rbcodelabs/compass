/** Handler functions for Squad MCP tools. */

import { revalidatePath } from "next/cache"
import getPrisma from "@/lib/db"
import { ok, fail } from "@/lib/mcp-output"

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
    return fail(`No workspace found with id "${workspaceId}".`)
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

  return ok(
    `**Squad created**\n` +
      `ID: ${squad.id}\n` +
      `Name: ${squad.name}\n` +
      `Color: ${squad.color}`,
    { id: squad.id, name: squad.name, color: squad.color },
  )
}

export async function listSquads({ workspaceId }: { workspaceId: string }) {
  const prisma = getPrisma()
  const squads = await prisma.squad.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
  })
  if (!squads.length) {
    return fail("No squads in this workspace.")
  }
  const lines = squads.map((s) => `• **${s.name}** (${s.color}) — ID: ${s.id}`)
  const items = squads.map((s) => ({ id: s.id, name: s.name, color: s.color }))
  return ok(lines.join("\n"), { items, count: items.length })
}

export async function getSquad({ squadId }: { squadId: string }) {
  const prisma = getPrisma()
  const squad = await prisma.squad.findUnique({
    where: { id: squadId },
    select: { id: true, workspaceId: true, name: true, color: true },
  })
  if (!squad) {
    return fail(`Squad "${squadId}" not found.`)
  }
  return ok(
    `**Squad:** ${squad.name}\n` +
      `ID: ${squad.id}\n` +
      `Workspace ID: ${squad.workspaceId}\n` +
      `Color: ${squad.color}`,
    squad,
  )
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
    return fail(`Squad "${squadId}" not found.`)
  }

  const squad = await prisma.squad.update({
    where: { id: squadId },
    data: {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(color !== undefined ? { color } : {}),
    },
  })

  revalidatePath(`/${existing.workspace.organization.slug}/${existing.workspace.slug}`, "layout")

  return ok(
    `**Squad updated**\n` +
      `ID: ${squad.id}\n` +
      `Name: ${squad.name}\n` +
      `Color: ${squad.color}`,
    { id: squad.id, name: squad.name, color: squad.color },
  )
}
