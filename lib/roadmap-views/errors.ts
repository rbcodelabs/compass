/** Expected failures of the saved-view service. Actions turn these into `{ ok: false }` results; anything else keeps throwing. */
export type RoadmapViewErrorCode = "NOT_FOUND" | "FORBIDDEN" | "INVALID" | "LIMIT"

export class RoadmapViewError extends Error {
  constructor(readonly code: RoadmapViewErrorCode, message: string) {
    super(message)
    this.name = "RoadmapViewError"
  }
}

export function isRoadmapViewError(error: unknown): error is RoadmapViewError {
  return error instanceof RoadmapViewError
}
