"use client"

import { useActionState, useState } from "react"
import { createOrganizationAndWorkspace, type OnboardingState } from "./actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FormField } from "@/components/patterns/form-field"
import { deriveSlug } from "@/lib/slug"

const initialState: OnboardingState = {}

export function OnboardingForm() {
  const [state, formAction, isPending] = useActionState(
    createOrganizationAndWorkspace,
    initialState
  )

  const [step, setStep] = useState<1 | 2>(1)
  const [orgName, setOrgName] = useState("")
  const [orgSlug, setOrgSlug] = useState("")
  const [workspaceName, setWorkspaceName] = useState("")

  function handleOrgNameChange(value: string) {
    setOrgName(value)
    // Auto-derive slug from org name if user hasn't manually edited it
    setOrgSlug(deriveSlug(value))
  }

  const hasStep1Errors =
    state.errors?.orgName || state.errors?.orgSlug

  return (
    <div className="w-full max-w-md space-y-8">
      {/* Header */}
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-5 h-5"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
            </svg>
          </div>
          <span className="text-xl font-semibold tracking-tight">Compass</span>
        </div>
        <p className="text-sm text-text-subtle">
          Let&apos;s set up your organization.
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 justify-center">
        <div className={`h-2 w-2 rounded-full ${step >= 1 ? "bg-primary" : "bg-border-strong"}`} />
        <div className={`h-px w-8 ${step >= 2 ? "bg-primary" : "bg-border-default"}`} />
        <div className={`h-2 w-2 rounded-full ${step >= 2 ? "bg-primary" : "bg-border-strong"}`} />
      </div>

      <form action={formAction} className="space-y-6">
        {/* Hidden fields to carry forward values between steps */}
        <input type="hidden" name="orgName" value={orgName} />
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="workspaceName" value={workspaceName} />

        <div className="space-y-6 rounded-xl border border-border-default bg-surface-panel p-6 shadow-[var(--shadow-card)]">
          {step === 1 && (
            <>
              <div className="space-y-1">
                <h1 className="text-lg font-semibold text-text-primary">
                  Create your organization
                </h1>
                <p className="text-sm text-text-subtle">
                  Your organization is the top-level container for all workspaces and teams.
                </p>
              </div>

              <div className="space-y-4">
                <FormField id="orgName-input" label="Organization name" required error={state.errors?.orgName?.[0]}>
                  <Input
                    id="orgName-input"
                    value={orgName}
                    onChange={(e) => handleOrgNameChange(e.target.value)}
                    placeholder="Acme Corp"
                    required
                    autoFocus
                  />
                </FormField>

                <FormField id="orgSlug-input" required error={state.errors?.orgSlug?.[0]} label={<>
                    URL slug
                    <span className="ml-2 text-xs font-normal text-text-subtle">
                      compass.app/<strong>{orgSlug || "your-org"}</strong>
                    </span>
                  </>}>
                  <Input
                    id="orgSlug-input"
                    value={orgSlug}
                    onChange={(e) => setOrgSlug(e.target.value)}
                    placeholder="acme-corp"
                    pattern="[a-z0-9-]+"
                    required
                  />
                </FormField>
              </div>

              {state.errors?._form && (
                <p role="alert" className="text-sm text-status-danger">{state.errors._form[0]}</p>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <div className="space-y-1">
                <h1 className="text-lg font-semibold text-text-primary">
                  Name your first workspace
                </h1>
                <p className="text-sm text-text-subtle">
                  A workspace is where your team works on OKRs, discovery, and experiments.
                  You can add more later.
                </p>
              </div>

              <FormField id="workspaceName-input" label="Workspace name" required error={state.errors?.workspaceName?.[0]}>
                <Input
                  id="workspaceName-input"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  placeholder="Product Team"
                  required
                  autoFocus
                />
              </FormField>

              {state.errors?._form && (
                <p role="alert" className="text-sm text-status-danger">{state.errors._form[0]}</p>
              )}
            </>
          )}
        </div>

        <div className="flex gap-3">
          {step === 2 && (
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => setStep(1)}
            >
              Back
            </Button>
          )}

          {step === 1 ? (
            <Button
              type="button"
              className="flex-1"
              disabled={!orgName || !orgSlug}
              onClick={() => {
                if (orgName && orgSlug) setStep(2)
              }}
            >
              Continue
            </Button>
          ) : (
            <Button
              type="submit"
              className="flex-1"
              disabled={isPending || !workspaceName}
            >
              {isPending ? "Creating..." : "Create workspace"}
            </Button>
          )}
        </div>

        {hasStep1Errors && step === 2 && (
          <p role="alert" className="text-center text-sm text-status-danger">
            Please go back and fix the errors above.
          </p>
        )}
      </form>
    </div>
  )
}
