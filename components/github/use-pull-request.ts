"use client"

import { useEffect, useState } from "react"

import { pullRequestPanelId, type PullRequestRef } from "@/lib/github-pull-request-links"
import type { PullRequestSummary } from "@/lib/github-pull-request-summary"

/**
 * Client loader shared by the PR chip and the PR sidebar. Module-level cache and in-flight map: a streaming reply re-renders the
 * transcript on every chunk and the same PR is often mentioned repeatedly. A 401/403/404 (or an unconfigured GitHub App) settles as
 * "unavailable", so the link stays an ordinary anchor and is not re-asked.
 */
const REVALIDATE_AFTER_MS = 30_000

type Entry = { summary: PullRequestSummary | null; fetchedAt: number }
const cache: Map<string, Entry> = new Map()
const inflight: Map<string, Promise<Entry | null>> = new Map()

function load(orgSlug: string, workspaceSlug: string, ref: PullRequestRef): Promise<Entry | null> {
  const id = pullRequestPanelId(ref)
  const key = [orgSlug, workspaceSlug, id].join("/")
  const pending = inflight.get(key)
  if (pending) return pending
  const qs = new URLSearchParams({ orgSlug, workspaceSlug, id })
  const request = fetch("/api/panels/github-pr?" + qs.toString())
    .then(async (res): Promise<Entry | null> => {
      if (res.ok) return { summary: (await res.json()) as PullRequestSummary, fetchedAt: Date.now() }
      if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 503) return { summary: null, fetchedAt: Date.now() }
      return null
    })
    .catch(() => null)
    .finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}

export function usePullRequest(orgSlug: string, workspaceSlug: string, ref: PullRequestRef | null): { summary: PullRequestSummary | null; settled: boolean } {
  const id = ref ? pullRequestPanelId(ref) : null
  const key = id ? [orgSlug, workspaceSlug, id].join("/") : null
  const [, bump] = useState(0)
  const entry = key ? cache.get(key) : undefined

  useEffect(() => {
    if (!ref || !key) return
    let cancelled = false
    const refresh = () => {
      const current = cache.get(key)
      if (current && Date.now() - current.fetchedAt < REVALIDATE_AFTER_MS) return
      void load(orgSlug, workspaceSlug, ref).then((next) => {
        if (cancelled || !next) return
        cache.set(key, next)
        bump((n) => n + 1)
      })
    }
    refresh()
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", refresh)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", refresh)
    }
    // ref is rebuilt per render; key is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, orgSlug, workspaceSlug])

  return { summary: entry?.summary ?? null, settled: entry !== undefined }
}
