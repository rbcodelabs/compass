"use client"

import { useActionState, useState } from "react"
import { createOrganizationAndWorkspace, type OnboardingState } from "./actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

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
    const derived = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
    setOrgSlug(derived)
  }

  const hasStep1Errors =
    state.errors?.orgName || state.errors?.orgSlug

  return (
    <div className="w-full max-w-md space-y-8">
      {/* Header */}
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-slate-900 flex items-center justify-center">
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
        <p className="text-sm text-slate-500">
          Let&apos;s set up your organization.
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 justify-center">
        <div className={`w-2 h-2 rounded-full ${step >= 1 ? "bg-slate-900" : "bg-slate-300"}`} />
        <div className={`w-8 h-px ${step >= 2 ? "bg-slate-900" : "bg-slate-200"}`} />
        <div className={`w-2 h-2 rounded-full ${step >= 2 ? "bg-slate-900" : "bg-slate-300"}`} />
      </div>

      <form action={formAction} className="space-y-6">
        {/* Hidden fields to carry forward values between steps */}
        <input type="hidden" name="orgName" value={orgName} />
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="workspaceName" value={workspaceName} />

        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm space-y-6">
          {step === 1 && (
            <>
              <div className="space-y-1">
                <h1 className="text-lg font-semibold text-slate-900">
                  Create your organization
                </h1>
                <p className="text-sm text-slate-500">
                  Your organization is the top-level container for all workspaces and teams.
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="orgName-input">Organization name</Label>
                  <Input
                    id="orgName-input"
                    value={orgName}
                    onChange={(e) => handleOrgNameChange(e.target.value)}
                    placeholder="Acme Corp"
                    required
                    autoFocus
                  />
                  {state.errors?.orgName && (
                    <p className="text-sm text-red-600">{state.errors.orgName[0]}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="orgSlug-input">
                    URL slug
                    <span className="ml-2 text-xs text-slate-400 font-normal">
                      compass.app/<strong>{orgSlug || "your-org"}</strong>
                    </span>
                  </Label>
                  <Input
                    id="orgSlug-input"
                    value={orgSlug}
                    onChange={(e) => setOrgSlug(e.target.value)}
                    placeholder="acme-corp"
                    pattern="[a-z0-9-]+"
                    required
                  />
                  {state.errors?.orgSlug && (
                    <p className="text-sm text-red-600">{state.errors.orgSlug[0]}</p>
                  )}
                </div>
              </div>

              {state.errors?._form && (
                <p className="text-sm text-red-600">{state.errors._form[0]}</p>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <div className="space-y-1">
                <h1 className="text-lg font-semibold text-slate-900">
                  Name your first workspace
                </h1>
                <p className="text-sm text-slate-500">
                  A workspace is where your team works on OKRs, discovery, and experiments.
                  You can add more later.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="workspaceName-input">Workspace name</Label>
                <Input
                  id="workspaceName-input"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  placeholder="Product Team"
                  required
                  autoFocus
                />
                {state.errors?.workspaceName && (
                  <p className="text-sm text-red-600">{state.errors.workspaceName[0]}</p>
                )}
              </div>

              {state.errors?._form && (
                <p className="text-sm text-red-600">{state.errors._form[0]}</p>
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
          <p className="text-sm text-red-600 text-center">
            Please go back and fix the errors above.
          </p>
        )}
      </form>
    </div>
  )
}
