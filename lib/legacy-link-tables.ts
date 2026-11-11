/**
 * The frozen `artifact_links` table. entity_links is the only store for Artifact links (lib/artifacts.ts); nothing reads or writes
 * this table any more. It still exists, with rows from before the cleanup, and Prisma's emulated referential integrity
 * (relationMode = "prisma") makes those rows Restrict the delete of their Artifact. So the two Artifact delete paths remove them here,
 * and this module is the ONLY place that names the model. It is deleted together with the table.
 */
import type { AppPrismaClient } from "@/lib/db"

type ArtifactLinkDeleter = { artifactLink: Pick<AppPrismaClient["artifactLink"], "deleteMany"> }

/** Removes the frozen artifact_links rows of one Artifact so the Artifact itself can be deleted. */
export async function deleteFrozenArtifactLinks(db: ArtifactLinkDeleter, input: { artifactId: string }): Promise<void> {
  await db.artifactLink.deleteMany({ where: { artifactId: input.artifactId } })
}

/** Removes every frozen artifact_links row stamped with the workspace, ahead of the workspace's Artifacts. */
export async function deleteFrozenWorkspaceArtifactLinks(db: ArtifactLinkDeleter, input: { workspaceId: string }): Promise<void> {
  await db.artifactLink.deleteMany({ where: { workspaceId: input.workspaceId } })
}
