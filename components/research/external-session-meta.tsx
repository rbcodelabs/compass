import { EXTERNAL_PROVENANCE } from "@/lib/research-external"

export function isExternalSession(session: { provenance: string | null }) {
  return session.provenance === EXTERNAL_PROVENANCE
}

/** Provenance label plus the member-entered details of an imported session. */
export function ExternalSessionMeta({ session }: { session: { participantName: string | null; participantEmail: string | null; externalUrl: string | null; sessionNotes: string | null } }) {
  return <div className="mt-2 space-y-2 text-xs text-text-muted">
    <p><span className="rounded-full border px-2 py-0.5 font-medium text-text-secondary">Imported from an external source</span> Member-reported; Compass has not verified it against the provider.</p>
    {(session.participantName || session.participantEmail) && <p>Participant: {[session.participantName, session.participantEmail].filter(Boolean).join(" · ")}</p>}
    {session.externalUrl && <p>Session link: <a className="break-all underline" href={session.externalUrl} rel="noopener noreferrer" target="_blank">{session.externalUrl}</a></p>}
    {session.sessionNotes && <div><div className="font-medium text-text-secondary">Notes</div><p className="mt-1 whitespace-pre-wrap text-sm text-text-subtle">{session.sessionNotes}</p></div>}
  </div>
}
