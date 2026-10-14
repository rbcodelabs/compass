/**
 * Constants and form-state types for external / manual research studies. Deliberately free of
 * server-only imports (no Node built-ins) so client form components can import it.
 */
export const EXTERNAL_PROVIDERS = ["USERTESTING", "MAZE", "OTHER"] as const
export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number]
export const EXTERNAL_PROVIDER_LABELS: Record<ExternalProvider, string> = {
  USERTESTING: "UserTesting",
  MAZE: "Maze",
  OTHER: "Other / manual",
}

export const EXTERNAL_PROVENANCE = "EXTERNAL_IMPORT"
export const MAX_EXTERNAL_TRANSCRIPT_CHARS = 60_000
export const MAX_EXTERNAL_NOTES_CHARS = 20_000
export const MAX_EXTERNAL_TURNS = 500

/**
 * State returned by the external study/session server actions. A rejected submission returns the
 * message to show inline and the values the member typed, so a validation error never discards a
 * pasted transcript (React resets uncontrolled fields after every form action). `attempt` changes on every
 * rejection so the form can remount its fields with the new defaults instead of mutating defaultValue in place.
 */
export type ExternalFormState = { error?: string; values?: Record<string, string>; attempt?: number }
