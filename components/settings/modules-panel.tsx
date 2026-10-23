"use client"

import { useState, useTransition } from "react"
import { setWorkspaceModuleEnabled } from "@/app/[orgSlug]/[workspaceSlug]/settings/modules/actions"
import { SettingsSection } from "@/components/patterns/settings-section"
import { Switch } from "@/components/ui/switch"
import type { ModuleView } from "@/lib/modules/server"

interface Props {
  orgSlug: string
  workspaceSlug: string
  canManage: boolean
  initialModules: ModuleView[]
}

/**
 * One switch per registered module, grouped. A module whose requirement is off cannot be switched on (the server refuses it and
 * names the requirement; the switch is also disabled here so nobody has to find that out by trying). Turning a module off also turns
 * off the modules that depend on it, and the returned list shows the result.
 */
export function ModulesPanel({ orgSlug, workspaceSlug, canManage, initialModules }: Props) {
  const [modules, setModules] = useState(initialModules)
  const [error, setError] = useState<string | null>(null)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  function toggle(key: string, enabled: boolean) {
    setError(null)
    setPendingKey(key)
    startTransition(async () => {
      try {
        const result = await setWorkspaceModuleEnabled(orgSlug, workspaceSlug, key, enabled)
        if (result.ok) setModules(result.modules)
        else setError(result.error)
      } finally {
        setPendingKey(null)
      }
    })
  }

  const groups = [...new Set(modules.map((module) => module.group))]
  return (
    <div className="flex flex-col gap-6">
      {!canManage && <p className="text-sm text-text-subtle">Only a workspace administrator can change modules. You can see what is on and why.</p>}
      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
      {groups.map((group) => (
        <SettingsSection key={group} title={group}>
          <ul className="flex flex-col divide-y divide-border-default">
            {modules.filter((module) => module.group === group).map((module) => {
              const missing = module.requires.filter((requirement) => !requirement.enabled)
              const cannotEnable = !module.selected && missing.length > 0
              return (
                <li key={module.key} className="flex items-start justify-between gap-4 py-3.5 first:pt-0 last:pb-0" data-testid={`module-row-${module.key}`}>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium">{module.label}</span>
                    <span className="text-xs text-text-subtle">{module.description}</span>
                    {module.sensitive && <span className="text-xs text-text-subtle">Guards a security-sensitive path; off unless you turn it on.</span>}
                    {module.requires.length > 0 && (
                      <span className="text-xs text-text-subtle">Requires {module.requires.map((requirement) => requirement.label).join(", ")}.</span>
                    )}
                    {module.selected && !module.enabled && (
                      <span role="status" className="text-xs text-status-danger">
                        On, but not active: {missing.map((requirement) => requirement.label).join(", ")} {missing.length === 1 ? "is" : "are"} off.
                      </span>
                    )}
                    {cannotEnable && <span className="text-xs text-text-subtle">Turn on {missing.map((requirement) => requirement.label).join(", ")} first.</span>}
                  </div>
                  <Switch
                    data-testid={`module-toggle-${module.key}`}
                    aria-label={module.label}
                    checked={module.selected}
                    disabled={!canManage || pendingKey !== null || cannotEnable}
                    onCheckedChange={(value) => toggle(module.key, value)}
                  />
                </li>
              )
            })}
          </ul>
        </SettingsSection>
      ))}
    </div>
  )
}
