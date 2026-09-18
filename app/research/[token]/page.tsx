import { notFound } from "next/navigation"
import { ResearchExperience } from "@/components/research/research-experience"
import { resolveActiveResearchStudy } from "@/lib/research-access"
import {
  isResearchDiscoveryVoiceEnabled,
  isResearchParticipantVoiceEnabled,
} from "@/lib/research-feature"
import getPrisma from "@/lib/db"
import { getArtifactStorage } from "@/lib/artifact-storage"
import { buildSandboxedHtml } from "@/lib/artifacts"

/**
 * Renders an artifact-backed USABILITY_TEST's current-revision HTML into a
 * CSP-wrapped string for the unauthenticated participant client to sandbox
 * further (see components/artifact-sandboxed-frame.tsx, which applies the
 * navigation-kill handshake client-side, exactly like the workspace-member
 * docs artifact viewer). Nothing beyond this HTML string is ever returned —
 * no artifactId, blobPathname, or other identifier reaches the client, per
 * the same DTO discipline lib/artifacts.ts's toArtifactDetailDto applies.
 *
 * A missing/archived artifact or unreadable blob degrades to `null` (no
 * prototype pane) rather than a hard failure — the participant session and
 * chat/voice modality still work either way.
 */
async function resolveArtifactHtml(artifactId: string): Promise<string | null> {
  const prisma = getPrisma()
  const artifact = await prisma.artifact.findFirst({
    where: { id: artifactId },
    include: { currentRevision: true },
  })
  const blobPathname = artifact?.currentRevision?.blobPathname
  if (!blobPathname) return null
  const bytes = await getArtifactStorage().get(blobPathname)
  if (!bytes) return null
  return buildSandboxedHtml(new TextDecoder().decode(bytes))
}

export default async function ParticipantResearchPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const resolved = await resolveActiveResearchStudy(token)
  if (!resolved) notFound()
  const { study } = resolved
  const artifactHtml = study.artifactId ? await resolveArtifactHtml(study.artifactId) : null
  const guided = study.studyType === "USABILITY_TEST" && (Boolean(study.appUrl) || Boolean(artifactHtml))
  return <main className={`mx-auto flex min-h-screen flex-col px-4 py-6 sm:py-10 ${guided ? "max-w-[100rem]" : "max-w-2xl"}`}><div className="mb-6"><div className="text-sm font-semibold text-primary">Compass research</div><h1 className="mt-2 text-2xl font-semibold">{study.name}</h1><p className="mt-2 text-text-subtle">{study.goal}</p><p className="mt-2 text-sm text-text-muted">About {study.targetMinutes} minutes · Your responses will be shared with the research team.</p></div><ResearchExperience token={token} studyName={study.name} studyType={study.studyType as "CUSTOMER_INTERVIEW" | "USABILITY_TEST"} appUrl={study.appUrl} artifactHtml={artifactHtml} legacyVoiceEnabled={isResearchParticipantVoiceEnabled()} discoveryVoiceEnabled={isResearchDiscoveryVoiceEnabled()} /></main>
}
