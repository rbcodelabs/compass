import Link from "next/link"
import { AnalysisButton, SynthesisHandoffButton } from "@/components/research/analysis-button"
import { readSessionAnalysis, readStudySynthesis, type SessionCoverage } from "@/lib/research-analysis"
import { researchTurnHref } from "@/lib/research-turn-link"
import type { ResearchGuideItem } from "@/lib/research"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

export function SessionAnalysisResults({ studyId, sessionId, status, summary, guide, sessionUrl }: { studyId: string; sessionId: string; status: string; summary: string | null; guide: ResearchGuideItem[]; sessionUrl: string }) {
  const stored = readSessionAnalysis(summary)
  const coverage: SessionCoverage | undefined = stored.analysis?.coverage
  return <div className="mt-3 space-y-3">
    <h3 className="font-medium">Interview summary</h3>
    <p className="whitespace-pre-wrap text-text-subtle">{stored.summary ?? (status === "COMPLETED" ? "Summary not available yet. The interview is saved; generate or retry below." : "Summary available after completion.")}</p>
    {status === "COMPLETED" && <div className="flex flex-wrap gap-2"><AnalysisButton studyId={studyId} sessionId={sessionId} kind="summary" regenerate={Boolean(stored.summary)}>{stored.summary ? "Regenerate summary" : "Generate summary"}</AnalysisButton><AnalysisButton studyId={studyId} sessionId={sessionId} kind="coverage" regenerate={Boolean(coverage)}>{coverage ? "Recheck guide coverage" : "Check guide coverage"}</AnalysisButton></div>}
    {coverage && <div><h3 className="font-medium">Guide coverage</h3><ul className="mt-2 space-y-2">{coverage.coverage.map(item => <li key={item.guideItemId}><span className="font-medium">{item.covered ? "Covered" : "Not addressed"}:</span> {guide.find(q => q.id === item.guideItemId)?.text ?? item.guideItemId}{item.evidenceTurnIds.map((id, index) => <Link className="ml-2 underline" key={id} href={`${sessionUrl}?turnId=${encodeURIComponent(id)}#turn-${id}`}>Evidence {index + 1}</Link>)}</li>)}</ul></div>}
    {(stored.summary || coverage) && <p className="text-xs text-text-muted">AI-generated analysis. Verify findings against the saved transcript.</p>}
  </div>
}

export function SynthesisResults({ snapshots, studyId, studyUrl, completedSessionIds, currentGuideFingerprint }: { snapshots: Array<{ id: string; content: string; sessionCount: number; createdAt: Date }>; studyId: string; studyUrl: string; completedSessionIds: string[]; currentGuideFingerprint: string }) {
  return <section className="max-w-3xl space-y-4 rounded-xl border bg-surface-panel p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Cross-session synthesis</h2><SynthesisHandoffButton studyId={studyId}>{snapshots.length ? "Regenerate synthesis" : "Generate synthesis"}</SynthesisHandoffButton></div>
    <p className="text-sm text-text-subtle">Findings from saved, completed interviews. Generation opens a Compass agent conversation that reads the saved transcripts and writes back a snapshot; earlier snapshots remain available. Voice source is unverified in this view; browser voice is participant-reported.</p>
    {!snapshots.length && <p className="text-sm text-text-muted">No synthesis yet. Complete an interview, then generate findings.</p>}
    {snapshots.map((snapshot, index) => {
      const content = readStudySynthesis(snapshot.content)
      const stale = content && (content.guideFingerprint !== currentGuideFingerprint || content.sourceSessionIds.length !== completedSessionIds.length || completedSessionIds.some(id => !content.sourceSessionIds.includes(id)))
      const reference = (id: string) => `${studyUrl}/sessions/${content?.sourceSessionIds.find(sessionId => sessionId === id) ?? id}`
      const evidence = (ids: string[]) => ids.map((id, i) => <Link key={id} className="ml-2 text-xs underline" href={researchTurnHref(studyUrl, id)}>Evidence {i + 1}</Link>)
      return <Collapsible key={snapshot.id} defaultOpen={index === 0} className="rounded-lg border p-4"><CollapsibleTrigger className="w-full cursor-pointer text-left text-sm font-medium">{snapshot.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC · {snapshot.sessionCount} sessions{stale ? " · New source data available" : ""}</CollapsibleTrigger><CollapsibleContent>
        {content ? <div className="mt-3 space-y-4 text-sm">
          <div><h3 className="font-semibold">Executive summary</h3><p className="mt-1 whitespace-pre-wrap">{content.summary}</p></div>
          <div><h3 className="font-semibold">Themes and surprises</h3>{content.themes.map((theme, i) => <article key={i} className="mt-3"><h4 className="font-medium">{theme.title}{theme.surprising ? " · Surprising finding" : ""}</h4><p>{theme.description}</p>{theme.quotes.map((quote, j) => <blockquote key={j} className="mt-2 border-l-2 pl-3 text-text-subtle"><p>“{quote.text}”</p><Link className="text-xs underline" href={`${reference(quote.sessionId)}?turnId=${encodeURIComponent(quote.turnId)}#turn-${quote.turnId}`}>View saved evidence</Link></blockquote>)}</article>)}</div>
          <div><h3 className="font-semibold">Cross-session patterns</h3>{content.patterns.length ? <ul className="list-disc space-y-1 pl-5">{content.patterns.map((item, i) => <li key={i}>{item.text}{evidence(item.evidenceTurnIds)}</li>)}</ul> : <p className="text-text-muted">Insufficient repeated evidence to identify cross-session patterns.</p>}</div>
          <div><h3 className="font-semibold">Jobs to be done</h3><ul className="space-y-2">{content.jobs.map((job, i) => <li key={i}><p>{job.job}</p><p className="text-text-subtle">{job.context}</p>{evidence(job.evidenceTurnIds)}</li>)}</ul></div>
          <div><h3 className="font-semibold">Recommendations</h3><ol className="list-decimal space-y-1 pl-5">{content.recommendations.map((item, i) => <li key={i}>{item.text}{evidence(item.evidenceTurnIds)}</li>)}</ol></div>
          <p className="text-xs text-text-muted">AI-generated snapshot. Quotes are checked against saved participant text; interpretations still require researcher review.</p>
        </div> : <p className="mt-3 whitespace-pre-wrap text-sm text-text-subtle">{snapshot.content}</p>}
      </CollapsibleContent></Collapsible>
    })}
  </section>
}
