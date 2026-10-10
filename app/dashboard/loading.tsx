import { WorkspaceTileSkeleton } from "@/components/workspace-selector/workspace-tile"
import "@/components/workspace-selector/workspace-selector.css"

/** Holds the gallery's layout while memberships load so the page does not jump. */
export default function DashboardLoading() {
  return (
    <div className="wsx wsx-route" aria-busy="true">
      <div className="wsx-topbar" aria-hidden="true">
        <span className="wsx-brand">
          <span className="wsx-brand-mark" />
          Compass
        </span>
      </div>
      <main className="wsx-body">
        <div className="wsx-page-head">
          <h1 className="wsx-display">Your workspaces</h1>
          <p className="wsx-context" role="status">
            Loading your workspaces…
          </p>
        </div>
        <ul className="wsx-grid" aria-label="Loading workspaces">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i}>
              <WorkspaceTileSkeleton />
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}
