"use client"

/**
 * The interactive half of the consent screen: choosing what the connection will
 * act as, and refusing to approve a choice that would do nothing (ADR 0015).
 *
 * ## Why this is one component and not two
 *
 * "Which agent" and "which workspaces" are the same decision, not two. An agent
 * created here with no `AgentWorkspaceGrant` rows reaches nothing, and a token
 * bound to it authenticates, clears every scope check and every tool gate, and
 * then answers "Workspace not found or access denied." to every single call.
 * That is a connection which reports success and silently does nothing — worse
 * than a refusal, because the client, the user and the logs all agree it
 * worked. So the grant picker is part of the create-an-agent option rather than
 * a separate step, and the primary action is disabled whenever the current
 * selection resolves to no reach.
 *
 * The converse is deliberate too: selecting an **existing** agent offers no
 * grant editing. Grants are workspace-administration state, visible and
 * revocable at `/settings/agents` and in each workspace's settings. Letting a
 * screen whose title is chosen by the requesting application quietly widen a
 * long-lived agent's standing reach would be a real privilege change smuggled
 * into an authorization flow, and the user would reasonably read the
 * checkboxes as scoping *this connection*.
 *
 * ## Why the action row uses `form=` instead of wrapping everything
 *
 * Cancel and Allow submit different bodies, and the Allow body now includes
 * fields that live up in the scrolling region. HTML forbids nested forms, so
 * the deny form is an empty sibling carrying only hidden inputs and the Cancel
 * button reaches it by id. That keeps the Phase 1 property the module doc
 * calls out — the decision travels as an ordinary hidden field rather than
 * depending on a button component forwarding `name`/`value` — while keeping
 * both buttons pinned outside the scroll region.
 */

import { useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import type { AgentReachEntry, ConsentBindingOptions } from "@/lib/oauth/agent-binding"

type Mode = "agent" | "new" | "user"

interface ConsentFormProps {
  signedRequest: string
  /** The static, server-rendered part of the card: heading, unverified notice, scopes. */
  details: ReactNode
  /** The full membership enumeration, shown only inside the override panel. */
  overrideReach: ReactNode
  options: ConsentBindingOptions
  /** The level an inline-created agent is granted, derived from the requested scopes. */
  inlineAccess: "READ" | "WRITE"
  userEmail: string | null
}

export function ConsentForm({
  signedRequest,
  details,
  overrideReach,
  options,
  inlineAccess,
  userEmail,
}: ConsentFormProps) {
  const { agents, grantable, overrideAvailable, agentsEnabled } = options

  const firstUsableAgent = agents.find((agent) => agent.reach.length > 0) ?? agents[0]
  const [mode, setMode] = useState<Mode>(() => {
    if (firstUsableAgent && firstUsableAgent.reach.length > 0) return "agent"
    if (grantable.length > 0) return "new"
    return firstUsableAgent ? "agent" : "new"
  })
  const [agentId, setAgentId] = useState<string>(firstUsableAgent?.id ?? "")
  const [agentName, setAgentName] = useState("")
  // Defaulted to every grantable workspace checked: the common case is "give it
  // what I can give it", and an empty default would make the most likely
  // outcome the blocked one.
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(grantable.map((workspace) => workspace.id)),
  )
  const [overrideArmed, setOverrideArmed] = useState(false)
  const [confirmation, setConfirmation] = useState("")

  const selectedAgent = agents.find((agent) => agent.id === agentId)
  const effectiveMode: Mode = overrideArmed ? "user" : mode

  const block = useMemo(
    () =>
      blockReason({
        mode: effectiveMode,
        agentsEnabled,
        selectedAgentName: selectedAgent?.name ?? null,
        selectedAgentReach: selectedAgent?.reach.length ?? 0,
        hasAgents: agents.length > 0,
        agentName,
        checkedCount: checked.size,
        grantableCount: grantable.length,
        confirmation,
        userEmail,
      }),
    [
      effectiveMode,
      agentsEnabled,
      selectedAgent,
      agents.length,
      agentName,
      checked.size,
      grantable.length,
      confirmation,
      userEmail,
    ],
  )

  const toggle = (id: string) =>
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <>
      {/*
        Hidden inputs only, so it contributes no layout. It exists solely so
        Cancel can submit a body that says "deny" and nothing else.
      */}
      <form id="oauth-consent-deny" action="/oauth/consent" method="POST" hidden>
        <input type="hidden" name="decision" value="deny" />
        <input type="hidden" name="request" value={signedRequest} />
      </form>

      <div className="flex min-h-0 flex-col rounded-2xl border border-border-default bg-surface-panel shadow-[var(--shadow-card)]">
        <form
          id="oauth-consent-allow"
          action="/oauth/consent"
          method="POST"
          className="flex min-h-0 flex-col"
        >
          <input type="hidden" name="decision" value="allow" />
          <input type="hidden" name="request" value={signedRequest} />
          <input type="hidden" name="binding" value={effectiveMode} />

          {/*
            `tabIndex` is load-bearing, not decoration. The buttons live outside
            this region, so without a focusable descendant a keyboard-only user
            could not scroll it at all (WCAG 2.1.1) — they would be able to
            reach "Allow access" while being physically unable to read the grant
            it approves. Making the region itself a tab stop restores arrow-key
            and Page Down scrolling, and the label says what they landed in.

            The binding controls inside are focusable, so the region is no
            longer the *only* way in — but a screen whose scrollability depends
            on which options happen to be rendered is not an accessible screen,
            and the zero-grantable case renders almost no controls at all.
          */}
          <div
            role="region"
            aria-label="Authorization details"
            tabIndex={0}
            className="min-h-0 space-y-4 overflow-y-auto p-6 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:p-7"
          >
            {details}

            {agentsEnabled ? (
              <>
                <ActAsSection
                  agents={agents}
                  grantable={grantable}
                  inlineAccess={inlineAccess}
                  mode={mode}
                  agentId={agentId}
                  agentName={agentName}
                  checked={checked}
                  disabled={overrideArmed}
                  onMode={setMode}
                  onAgent={(id) => {
                    setMode("agent")
                    setAgentId(id)
                  }}
                  onName={setAgentName}
                  onToggle={toggle}
                />
                <EffectiveReachSection
                  mode={effectiveMode}
                  selectedReach={selectedAgent?.reach ?? []}
                  newGrants={grantable.filter((workspace) => checked.has(workspace.id))}
                  inlineAccess={inlineAccess}
                  overrideReach={overrideReach}
                />
                {overrideAvailable ? (
                  <OverrideDisclosure
                    armed={overrideArmed}
                    onArm={setOverrideArmed}
                    confirmation={confirmation}
                    onConfirmation={setConfirmation}
                    userEmail={userEmail}
                    reach={overrideReach}
                  />
                ) : (
                  <p className="text-sm text-text-subtle">
                    Authorizing as yourself, with your full account access, is only offered to
                    owners and administrators of every organization they belong to. Connecting as
                    an agent is the option available to you.
                  </p>
                )}
              </>
            ) : (
              overrideReach
            )}
          </div>
        </form>

        <div className="shrink-0 space-y-3 border-t border-border-default p-4 sm:px-7 sm:py-5">
          {/*
            In the pinned region, never inside the scroll area: the reason a
            button is disabled has to be visible at the same moment the disabled
            button is, or the screen just looks broken.
          */}
          {block ? (
            <p id="consent-blocked" className="text-sm text-status-warning">
              {block}
            </p>
          ) : null}
          <div className="flex gap-3">
            <Button
              type="submit"
              form="oauth-consent-deny"
              variant="outline"
              className="h-11 flex-1 font-semibold"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="oauth-consent-allow"
              variant={effectiveMode === "user" ? "destructive" : "default"}
              disabled={block !== null}
              aria-describedby={block ? "consent-blocked" : undefined}
              className="h-11 flex-1 font-semibold shadow-sm"
            >
              {effectiveMode === "user" ? "Allow full account access" : "Allow access"}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * Why approval is refused, or `null`.
 *
 * Every branch names the remedy rather than just the fault. "Allow access is
 * disabled" with no explanation is indistinguishable from a broken page, and
 * the two cases most likely to hit it — an agent with no grants, and a user who
 * administers nothing — are both fixed by someone else doing something
 * specific, somewhere specific.
 */
export function blockReason(state: {
  mode: Mode
  agentsEnabled: boolean
  selectedAgentName: string | null
  selectedAgentReach: number
  hasAgents: boolean
  agentName: string
  checkedCount: number
  grantableCount: number
  confirmation: string
  userEmail: string | null
}): string | null {
  if (!state.agentsEnabled) return null
  switch (state.mode) {
    case "agent":
      if (!state.hasAgents || !state.selectedAgentName) return "Choose an agent to continue."
      if (state.selectedAgentReach === 0) {
        return `${state.selectedAgentName} has not been granted access to any workspace, so this connection would fail every request. Ask a workspace administrator to grant it access in that workspace's settings, then start again.`
      }
      return null
    case "new":
      if (state.grantableCount === 0) {
        return "You are not an administrator of any workspace you belong to, so an agent created here could not reach anything. Ask a workspace administrator to create or grant an agent for you, then start again."
      }
      if (!state.agentName.trim()) return "Name the new agent to continue."
      if (state.checkedCount === 0) {
        return "Select at least one workspace. An agent with no workspace access would fail every request."
      }
      return null
    case "user": {
      const expected = (state.userEmail ?? "").trim().toLowerCase()
      if (!expected) return "Your account has no email address to confirm with."
      if (state.confirmation.trim().toLowerCase() !== expected) {
        return "Type your own email address exactly to confirm full account access."
      }
      return null
    }
  }
}

function ActAsSection({
  agents,
  grantable,
  inlineAccess,
  mode,
  agentId,
  agentName,
  checked,
  disabled,
  onMode,
  onAgent,
  onName,
  onToggle,
}: {
  agents: ConsentBindingOptions["agents"]
  grantable: ConsentBindingOptions["grantable"]
  inlineAccess: "READ" | "WRITE"
  mode: Mode
  agentId: string
  agentName: string
  checked: Set<string>
  disabled: boolean
  onMode: (mode: Mode) => void
  onAgent: (id: string) => void
  onName: (name: string) => void
  onToggle: (id: string) => void
}) {
  return (
    <fieldset
      disabled={disabled}
      className="space-y-2 disabled:opacity-40"
      aria-describedby="act-as-help"
    >
      <legend className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
        Act as
      </legend>
      <p id="act-as-help" className="text-sm text-text-subtle">
        This application will act as one of your agents. An agent can only reach the workspaces it
        has been granted, and cannot use administrator tools.
      </p>

      <div className="space-y-2 rounded-xl border border-border-default bg-surface-app p-3">
        {agents.map((agent) => (
          <label key={agent.id} className="flex cursor-pointer gap-2.5 text-sm">
            <input
              type="radio"
              name="agentId"
              value={agent.id}
              checked={mode === "agent" && agentId === agent.id}
              onChange={() => onAgent(agent.id)}
              className="mt-1 size-4 shrink-0 accent-[var(--color-primary)]"
            />
            <span className="space-y-0.5">
              <span className="block font-medium text-text-primary">{agent.name}</span>
              <span className="block text-text-subtle">
                {agent.reach.length === 0
                  ? "No workspace access — cannot be used for this connection"
                  : agent.reach
                      .map((entry) => `${entry.workspaceName}${entry.access === "READ" ? " (read only)" : ""}`)
                      .join(" · ")}
              </span>
            </span>
          </label>
        ))}

        <label className="flex cursor-pointer gap-2.5 text-sm">
          <input
            type="radio"
            name="agentId"
            value="__new__"
            checked={mode === "new"}
            onChange={() => onMode("new")}
            className="mt-1 size-4 shrink-0 accent-[var(--color-primary)]"
          />
          <span className="space-y-0.5">
            <span className="block font-medium text-text-primary">Create a new agent…</span>
            {agents.length === 0 ? (
              <span className="block text-text-subtle">You do not have any agents yet.</span>
            ) : null}
          </span>
        </label>

        {mode === "new" ? (
          <div className="ml-6 space-y-3 border-l border-border-default pl-3">
            <label className="block space-y-1 text-sm">
              <span className="font-medium text-text-primary">Name</span>
              <input
                type="text"
                name="agentName"
                value={agentName}
                maxLength={120}
                autoComplete="off"
                onChange={(event) => onName(event.target.value)}
                placeholder="e.g. Geode PM Agent"
                className="w-full rounded-lg border border-border-default bg-surface-panel px-3 py-2 text-sm text-text-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </label>

            <GrantPicker
              grantable={grantable}
              checked={checked}
              inlineAccess={inlineAccess}
              disabled={disabled}
              onToggle={onToggle}
            />
          </div>
        ) : null}
      </div>
    </fieldset>
  )
}

/**
 * The workspaces an inline-created agent will be granted.
 *
 * ## The empty case is the important one
 *
 * The grantable set is "workspaces where you are a member **and** an
 * administrator" — the exact predicate `grantWorkspaceAgent` enforces. For
 * anyone who is a plain member of someone else's organization it is **empty**,
 * and their inline-created agent could not reach the workspaces they actually
 * work in. The screen says that, in those words, rather than rendering an empty
 * box and letting the user conclude the feature is broken. The alternative —
 * letting consent grant more than Settings can — would relax the delegation
 * model on the one screen a third party controls the framing of.
 */
function GrantPicker({
  grantable,
  checked,
  inlineAccess,
  disabled,
  onToggle,
}: {
  grantable: ConsentBindingOptions["grantable"]
  checked: Set<string>
  inlineAccess: "READ" | "WRITE"
  disabled: boolean
  onToggle: (id: string) => void
}) {
  if (grantable.length === 0) {
    return (
      <div className="space-y-1.5 rounded-lg border border-status-warning/30 bg-status-warning-surface p-3 text-sm">
        <p className="font-semibold text-status-warning">No workspaces you can grant</p>
        <p className="text-text-primary">
          Granting an agent access to a workspace requires you to be an administrator of that
          workspace, or an owner or administrator of its organization. You are not an administrator
          of any workspace you belong to, so an agent created here would have no access and every
          request would fail.
        </p>
        <p className="text-text-subtle">
          Ask a workspace administrator to grant an agent access in that workspace&rsquo;s settings,
          then start this authorization again and select it above.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-1.5 text-sm">
      <p className="font-medium text-text-primary">Give it access to</p>
      <p className="text-text-subtle">
        {inlineAccess === "WRITE"
          ? "Read and write, because this application asked to create and change data."
          : "Read only, because this application asked only to read."}
      </p>
      <ul className="space-y-1">
        {grantable.map((workspace) => (
          <li key={workspace.id}>
            <label className="flex cursor-pointer items-start gap-2.5">
              <Checkbox
                name="grantWorkspaceId"
                value={workspace.id}
                checked={checked.has(workspace.id)}
                disabled={disabled}
                onCheckedChange={() => onToggle(workspace.id)}
                className="mt-0.5"
              />
              <span className="text-text-primary">
                {workspace.name}
                <span className="text-text-subtle"> · {workspace.organizationName}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * What the token will actually see, recomputed from the current selection.
 *
 * Phase 1's "Where it will have access" enumerated every membership, because
 * that was the truth for a user-mode token. Under an agent binding it would be
 * an overstatement of exactly the kind this screen exists to prevent, so the
 * section is *replaced* rather than added beside: it now shows the chosen
 * binding's effective reach, and only the override shows the full enumeration.
 */
function EffectiveReachSection({
  mode,
  selectedReach,
  newGrants,
  inlineAccess,
  overrideReach,
}: {
  mode: Mode
  selectedReach: AgentReachEntry[]
  newGrants: ConsentBindingOptions["grantable"]
  inlineAccess: "READ" | "WRITE"
  overrideReach: ReactNode
}) {
  if (mode === "user") {
    return (
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Where it will have access
        </h2>
        {overrideReach}
      </section>
    )
  }

  const entries: Array<{ key: string; label: string; org: string; access: "READ" | "WRITE" }> =
    mode === "new"
      ? newGrants.map((workspace) => ({
          key: workspace.id,
          label: workspace.name,
          org: workspace.organizationName,
          access: inlineAccess,
        }))
      : selectedReach.map((entry) => ({
          key: entry.workspaceId,
          label: entry.workspaceName,
          org: entry.organizationName,
          access: entry.access,
        }))

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
        Where it will have access
      </h2>
      {entries.length === 0 ? (
        <p className="text-sm text-status-warning">
          Nothing yet. A connection with no workspace access fails every request, so it cannot be
          approved as it stands.
        </p>
      ) : (
        <ul className="space-y-1 rounded-xl border border-border-default bg-surface-app p-3">
          {entries.map((entry) => (
            <li key={entry.key} className="text-sm text-text-primary">
              {entry.label}
              <span className="text-text-subtle">
                {" "}
                · {entry.org} · {entry.access === "WRITE" ? "read and write" : "read only"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * The admin override, presented so it cannot be taken by accident.
 *
 * It is not a radio button in the "Act as" list, because a list of peers is
 * exactly how something gets chosen without being read. Four independent
 * things must happen before it can be submitted, and no two of them are the
 * same gesture: the disclosure must be expanded, a checkbox that names what is
 * being waived must be ticked, the user's own email must be typed in full, and
 * the primary button — which has by then turned destructive and changed its
 * label — must be pressed. A stray Enter, a mis-click, or a keyboard user
 * tabbing through cannot produce all four.
 *
 * The server re-checks all of it anyway: the predicate must hold at submit
 * time, and the typed value must equal the session user's email.
 */
function OverrideDisclosure({
  armed,
  onArm,
  confirmation,
  onConfirmation,
  userEmail,
  reach,
}: {
  armed: boolean
  onArm: (armed: boolean) => void
  confirmation: string
  onConfirmation: (value: string) => void
  userEmail: string | null
  reach: ReactNode
}) {
  return (
    <details
      className="rounded-xl border border-destructive/30 bg-destructive/5"
      onToggle={(event) => {
        // Collapsing disarms. Leaving it armed inside a closed disclosure would
        // put the screen in its most dangerous state with no visible sign of it
        // — the button label is the only tell, and that is not enough.
        if (!(event.currentTarget as HTMLDetailsElement).open && armed) onArm(false)
      }}
    >
      <summary className="cursor-pointer p-3 text-sm font-semibold text-destructive">
        Authorize as yourself instead
      </summary>
      <div className="space-y-3 border-t border-destructive/20 p-3 text-sm">
        <p className="text-text-primary">
          This gives the application your own access, not an agent&rsquo;s. Four protections are
          waived:
        </p>
        <ul className="ml-4 list-disc space-y-1 text-text-primary">
          <li>Every workspace you belong to, including ones no agent was granted</li>
          <li>Administrator tools, which no agent may use</li>
          <li>The 17 tools reserved for a human identity</li>
          <li>The per-call audit trail agents write for every change</li>
        </ul>
        <div className="space-y-1">
          <p className="font-medium text-text-primary">It would be able to reach:</p>
          {reach}
        </div>
        <label className="flex cursor-pointer items-start gap-2.5">
          <Checkbox
            checked={armed}
            onCheckedChange={onArm}
            className="mt-0.5 data-checked:border-destructive data-checked:bg-destructive data-checked:text-destructive-foreground"
          />
          <span className="text-text-primary">
            I understand this grants my full account access across every organization above.
          </span>
        </label>
        {armed ? (
          <label className="block space-y-1">
            <span className="font-medium text-text-primary">
              Type {userEmail ?? "your email address"} to confirm
            </span>
            <input
              type="text"
              name="confirmation"
              value={confirmation}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onConfirmation(event.target.value)}
              className="w-full rounded-lg border border-destructive/40 bg-surface-panel px-3 py-2 text-sm text-text-primary outline-none focus-visible:ring-3 focus-visible:ring-destructive/30"
            />
          </label>
        ) : null}
      </div>
    </details>
  )
}
