import type { PortalHomeWidget } from "./schema"

export interface HomeViewer {
  /** The visitor has a valid portal session (not a Compass workspace member check). */
  signedIn: boolean
}

/**
 * Whether a customer may see the widget. Enforced server-side before any data
 * is resolved (see resolve.ts); the UI never relies on hiding.
 *
 *  - everyone: always.
 *  - signed_in: only with a portal session.
 *  - segments: disabled in v1 (segments are stored but not evaluable), so it is
 *    shown to nobody rather than leaked to everybody. Fail closed.
 *  - team: workspace members only, so never a customer, signed in or not.
 *  - anything else (an unknown future value): not shown. Fail closed.
 */
export function isWidgetVisibleToCustomer(widget: Pick<PortalHomeWidget, "visibility">, viewer: HomeViewer): boolean {
  switch (widget.visibility) {
    case "everyone":
      return true
    case "signed_in":
      return viewer.signedIn
    case "team":
    case "segments":
      return false
    default:
      return false
  }
}

/**
 * Whether the team home (workspace members) may see the widget. Members see
 * everything a customer could, plus "team" widgets. "segments" stays hidden
 * (not evaluable yet); the admin editor still lists it, flagged.
 */
export function isWidgetVisibleToTeam(widget: Pick<PortalHomeWidget, "visibility">): boolean {
  switch (widget.visibility) {
    case "everyone":
    case "signed_in":
    case "team":
      return true
    default:
      return false
  }
}
