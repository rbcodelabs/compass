"use client"

import { useState, useTransition } from "react"
import { createApiKey, revokeApiKey } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions"

export type ApiKeyRow = {
  id: string
  name: string
  keyPrefix: string
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

type Props = {
  orgSlug: string
  workspaceSlug: string
  initialKeys: ApiKeyRow[]
}

export function ManageApiKeysPanel({ orgSlug, workspaceSlug, initialKeys }: Props) {
  const [keys, setKeys] = useState<ApiKeyRow[]>(initialKeys)
  const [newName, setNewName] = useState("")
  const [newKey, setNewKey] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handleCreate() {
    if (!newName.trim()) return
    setError(null)
    startTransition(async () => {
      try {
        const result = await createApiKey(orgSlug, workspaceSlug, newName.trim())
        setNewKey(result.rawKey)
        setNewName("")
        // Refresh key list — server action revalidated the path, but since this
        // is a client component we just refetch by reloading the server-rendered data
        // The page will re-render with fresh data from the server on next navigation.
        // For now, add an optimistic stub so the list updates immediately.
        setKeys((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            name: newName.trim(),
            keyPrefix: result.rawKey.slice(4, 12),
            createdAt: new Date(),
            lastUsedAt: null,
            revokedAt: null,
          },
        ])
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to create key")
      }
    })
  }

  function handleRevoke(keyId: string) {
    setError(null)
    startTransition(async () => {
      try {
        await revokeApiKey(orgSlug, workspaceSlug, keyId)
        setKeys((prev) =>
          prev.map((k) => (k.id === keyId ? { ...k, revokedAt: new Date() } : k))
        )
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to revoke key")
      }
    })
  }

  const activeKeys = keys.filter((k) => !k.revokedAt)
  const revokedKeys = keys.filter((k) => k.revokedAt)

  return (
    <div className="flex flex-col gap-4">
      {/* New key form */}
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Key name (e.g. Claude Desktop)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          disabled={isPending}
        />
        <button
          onClick={handleCreate}
          disabled={isPending || !newName.trim()}
          className="h-9 px-4 rounded-md bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Generate
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* One-time key reveal */}
      {newKey && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-emerald-800">
            Copy this key now — it will never be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-white border border-emerald-200 rounded px-2 py-1 font-mono break-all">
              {newKey}
            </code>
            <button
              onClick={() => { navigator.clipboard.writeText(newKey); }}
              className="shrink-0 text-xs text-emerald-700 hover:text-emerald-900 font-medium"
            >
              Copy
            </button>
          </div>
          <button
            onClick={() => setNewKey(null)}
            className="self-end text-xs text-emerald-600 hover:text-emerald-800"
          >
            I&apos;ve saved it ✓
          </button>
        </div>
      )}

      {/* Active keys */}
      {activeKeys.length > 0 && (
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Name</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Prefix</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Created</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Last used</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {activeKeys.map((k) => (
                <tr key={k.id} className="bg-white">
                  <td className="px-3 py-2 font-medium text-slate-900">{k.name}</td>
                  <td className="px-3 py-2 font-mono text-slate-500">cmp_{k.keyPrefix}…</td>
                  <td className="px-3 py-2 text-slate-500">
                    {k.createdAt.toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 text-slate-500">
                    {k.lastUsedAt ? k.lastUsedAt.toLocaleDateString() : "Never"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => handleRevoke(k.id)}
                      disabled={isPending}
                      className="text-xs text-red-600 hover:text-red-800 disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeKeys.length === 0 && !newKey && (
        <p className="text-sm text-muted-foreground">No API keys yet. Generate one above.</p>
      )}

      {/* Revoked keys */}
      {revokedKeys.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            {revokedKeys.length} revoked {revokedKeys.length === 1 ? "key" : "keys"}
          </summary>
          <div className="rounded-md border border-border overflow-hidden mt-2">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {revokedKeys.map((k) => (
                  <tr key={k.id} className="bg-slate-50 opacity-60">
                    <td className="px-3 py-2 font-medium line-through text-slate-500">{k.name}</td>
                    <td className="px-3 py-2 font-mono text-slate-400">cmp_{k.keyPrefix}…</td>
                    <td className="px-3 py-2 text-slate-400">
                      Revoked {k.revokedAt?.toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  )
}
