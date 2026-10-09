export type PackSkill = { id: string; enabledByDefault?: boolean }

/**
 * Carry a workspace's skill choices across a pack upgrade.
 *
 * - A skill present in both versions keeps whatever the admin chose.
 * - A skill that is new in the target version follows its default, because the
 *   admin has never had the chance to opt in or out of it.
 * - A skill the target version dropped is removed (it cannot be enabled).
 *
 * This deliberately differs from a manual version switch in the version picker,
 * which resets to the chosen version's defaults: the picker is also the rollback
 * path, where a clean slate is the point. "Update to latest" is a forward step on
 * the same pack, so it should not silently undo the admin's configuration.
 */
export function mergeSkillSelection(previous: { skills: PackSkill[]; enabledSkillIds: string[] }, next: { skills: PackSkill[] }): string[] {
  const previousIds = new Set(previous.skills.map((skill) => skill.id))
  const enabled = new Set(previous.enabledSkillIds)
  return next.skills
    .filter((skill) => (previousIds.has(skill.id) ? enabled.has(skill.id) : skill.enabledByDefault !== false))
    .map((skill) => skill.id)
    .sort()
}

export type PackUpdateStatus = { installedCommit: string; latestCommit: string; updateAvailable: boolean }

export function describePackUpdate(installedCommit: string, latestCommit: string): PackUpdateStatus {
  return { installedCommit, latestCommit, updateAvailable: installedCommit !== latestCommit }
}
