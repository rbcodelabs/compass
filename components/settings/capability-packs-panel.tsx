"use client"

import { useId, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { installAgenticPmCapabilityPack, installWorkspaceCapabilityPack, updateWorkspaceCapabilityPack } from "@/app/[orgSlug]/[workspaceSlug]/settings/capability-pack-actions"
import { isAgenticPmPack } from "@/lib/capability-pack-curated"

export type CapabilityPackSettingsRow = { packId: string; sourceRepository: string; sourcePath: string; displayName: string; enabled: boolean; selectedVersionId: string; enabledSkillIds: string[]; versions: Array<{ id: string; version: string; commit: string; digest: string; skills: Array<{ id: string; enabledByDefault?: boolean }> }> }

export function CapabilityPacksPanel({ orgSlug, workspaceSlug, initialPacks }: { orgSlug: string; workspaceSlug: string; initialPacks: CapabilityPackSettingsRow[] }) {
  const [source, setSource] = useState({ repositoryUrl: "", commitSha: "", packPath: "packs/compass" })
  const [error, setError] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [installingCurated, setInstallingCurated] = useState(false)
  const advancedId = useId()
  const curatedInstalled = installed || initialPacks.some(isAgenticPmPack)
  const [pending, startTransition] = useTransition()
  const run = (work: () => Promise<unknown>) => startTransition(async () => { setError(null); try { const result = await work(); if (result && typeof result === "object" && "error" in result && typeof result.error === "string") setError(result.error) } catch (cause) { setError(cause instanceof Error ? cause.message : "Capability pack operation failed") } })
  return <div className="space-y-6">
    <div className="space-y-3 rounded-lg border border-border-default p-4">
      <p className="font-medium">Agentic PM pack</p>
      <p className="text-sm text-text-secondary">Add product discovery and delivery skills. Your installed version stays unchanged until you choose to update it.</p>
      <Button disabled={pending || curatedInstalled} onClick={() => run(async () => {
        setInstallingCurated(true)
        try {
          const result = await installAgenticPmCapabilityPack(orgSlug, workspaceSlug)
          if ("installed" in result) setInstalled(true)
          return result
        } finally { setInstallingCurated(false) }
      })}>{curatedInstalled ? "Agentic PM pack installed" : installingCurated ? "Installing…" : "Install Agentic PM pack"}</Button>
      {curatedInstalled && <p role="status" className="text-sm text-text-secondary">Installed. Your version and skill choices are preserved; manage them below.</p>}
      <Button variant="ghost" aria-expanded={advanced} aria-controls={advancedId} onClick={() => setAdvanced(!advanced)}>Advanced</Button>
      {advanced && <div id={advancedId} className="space-y-3">
      <p className="text-sm text-text-secondary">Install a declarative skills-only pack from public GitHub at an immutable commit.</p>
      <Input aria-label="GitHub repository URL" placeholder="https://github.com/owner/repository" value={source.repositoryUrl} onChange={(e) => setSource({ ...source, repositoryUrl: e.target.value })} />
      <Input aria-label="Full commit SHA" placeholder="40-character commit SHA" value={source.commitSha} onChange={(e) => setSource({ ...source, commitSha: e.target.value })} />
      <Input aria-label="Pack path" value={source.packPath} onChange={(e) => setSource({ ...source, packPath: e.target.value })} />
      <Button disabled={pending || !source.repositoryUrl || !source.commitSha || !source.packPath} onClick={() => run(() => installWorkspaceCapabilityPack(orgSlug, workspaceSlug, source))}>Install and enable</Button>
      </div>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {initialPacks.map((row) => { const selected = row.versions.find((v) => v.id === row.selectedVersionId) ?? row.versions[0]; return <div key={row.selectedVersionId} className="space-y-3 rounded-lg border border-border-default p-4">
      <div className="flex items-center justify-between"><div><p className="font-medium">{row.displayName}</p><p className="text-xs text-text-muted">{row.packId} · {selected?.digest.slice(0, 12)}</p></div><Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => updateWorkspaceCapabilityPack(orgSlug, workspaceSlug, { packVersionId: row.selectedVersionId, enabledSkillIds: row.enabledSkillIds, enabled: !row.enabled }))}>{row.enabled ? "Disable" : "Enable"}</Button></div>
      <label className="block text-sm">Version<select className="mt-1 w-full rounded-lg border border-border-default bg-background px-3 py-2" disabled={pending} value={row.selectedVersionId} onChange={(e) => { const next = row.versions.find((v) => v.id === e.target.value); if (next) run(() => updateWorkspaceCapabilityPack(orgSlug, workspaceSlug, { packVersionId: next.id, enabledSkillIds: next.skills.filter((s) => s.enabledByDefault !== false).map((s) => s.id), enabled: row.enabled })) }}>{row.versions.map((v) => <option key={v.id} value={v.id}>{v.version} · {v.commit.slice(0, 8)}</option>)}</select></label>
      <div className="space-y-2">{selected?.skills.map((skill) => <label key={skill.id} className="flex items-center gap-2 text-sm"><Checkbox disabled={pending} checked={row.enabledSkillIds.includes(skill.id)} onCheckedChange={(checked) => run(() => updateWorkspaceCapabilityPack(orgSlug, workspaceSlug, { packVersionId: row.selectedVersionId, enabledSkillIds: checked ? [...row.enabledSkillIds, skill.id] : row.enabledSkillIds.filter((id) => id !== skill.id), enabled: row.enabled }))} />{skill.id}</label>)}</div>
    </div> })}
    {initialPacks.length === 0 && <p className="text-sm text-text-muted">No capability packs installed.</p>}
  </div>
}
