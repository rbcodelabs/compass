"use server"

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { redirect } from "next/navigation"
import { z } from "zod"

const OnboardingSchema = z.object({
  orgName: z.string().min(1, "Organization name is required").max(255),
  orgSlug: z
    .string()
    .min(1, "Slug is required")
    .max(255)
    .regex(/^[a-z0-9-]+$/, "Slug may only contain lowercase letters, numbers, and hyphens"),
  workspaceName: z.string().min(1, "Workspace name is required").max(255),
})

export type OnboardingState = {
  errors?: {
    orgName?: string[]
    orgSlug?: string[]
    workspaceName?: string[]
    _form?: string[]
  }
}

export async function createOrganizationAndWorkspace(
  _prevState: OnboardingState,
  formData: FormData
): Promise<OnboardingState> {
  const session = await auth()
  if (!session?.user?.id) {
    return { errors: { _form: ["You must be signed in to continue."] } }
  }

  const parsed = OnboardingSchema.safeParse({
    orgName: formData.get("orgName"),
    orgSlug: formData.get("orgSlug"),
    workspaceName: formData.get("workspaceName"),
  })

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  const { orgName, orgSlug, workspaceName } = parsed.data
  const userId = session.user.id

  const prisma = getPrisma()

  // Check slug uniqueness
  const existing = await prisma.organization.findFirst({
    where: { slug: orgSlug },
  })

  if (existing) {
    return { errors: { orgSlug: ["This slug is already taken. Please choose another."] } }
  }

  // Derive workspace slug from name
  const workspaceSlug = workspaceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "workspace"

  // Create org, member, workspace, workspace member in sequence
  // (relationMode = "prisma" — no FK constraints, so we can create in order)
  const org = await prisma.organization.create({
    data: { name: orgName, slug: orgSlug },
  })

  await prisma.organizationMember.create({
    data: { organizationId: org.id, userId, role: "OWNER" },
  })

  const workspace = await prisma.workspace.create({
    data: { organizationId: org.id, name: workspaceName, slug: workspaceSlug },
  })

  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId, role: "ADMIN" },
  })

  redirect(`/${orgSlug}/${workspaceSlug}/okrs`)
}
