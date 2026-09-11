"use server"

import { redirect } from "next/navigation"
import { auth } from "@/auth"
import { createPmInterview } from "@/lib/pm-interview-service"

export async function launchPmInterview(orgSlug: string, workspaceSlug: string, form: FormData) {
  const session = await auth(); if (!session?.user?.id) redirect("/login")
  const combined = String(form.get("target") ?? ""), [combinedType, combinedId] = combined.split(":")
  const result = await createPmInterview({ orgSlug, workspaceSlug }, { userId: session.user.id }, { targetType: form.get("targetType") ?? combinedType, targetId: String(form.get("targetId") ?? combinedId ?? "") })
  redirect(`/${orgSlug}/${workspaceSlug}/capture/pm/${result.id}`)
}
