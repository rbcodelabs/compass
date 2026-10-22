/** Expected failures of the saved-view service. Actions turn these into `{ ok: false }` results; anything else keeps throwing. */
export type SavedViewErrorCode = "NOT_FOUND" | "FORBIDDEN" | "INVALID" | "LIMIT" | "CONFLICT"

export class SavedViewError extends Error {
  constructor(readonly code: SavedViewErrorCode, message: string) {
    super(message)
    this.name = "SavedViewError"
  }
}

export function isSavedViewError(error: unknown): error is SavedViewError {
  return error instanceof SavedViewError
}
