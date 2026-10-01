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
 */
export function isWidgetVisibleToCustomer(widget: Pick<PortalHomeWidget, "visibility">, viewer: HomeViewer): boolean {
  switch (widget.visibility) {
    case "everyone":
      return true
    case "signed_in":
      return viewer.signedIn
    default:
      return false
  }
}
