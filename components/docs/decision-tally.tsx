"use client";
/**
 * The options and advisory vote counts of an embedded Decision (ADR-0030), drawn inside the embed card.
 *
 * Purely presentational: it renders the tally the server resolved and calls `vote` when the person picks an option. `vote` is null when
 * this viewer may not vote (a read-only member, or the page is read-only), so the options render as a plain result. Picking the option you
 * already chose retracts the vote. Votes are advisory and anonymous until the Decision is decided; once decided the names are shown.
 */
import { useState } from "react";
import type { DecisionTally } from "@/lib/decision-votes";

/** Cast (option) or retract (null) the vote on one question. Resolves to an error message, or null on success. */
export type VoteFn = (questionIndex: number, option: string | null) => Promise<string | null>;

export function DecisionTallyView({ tally, vote }: { tally: DecisionTally; vote: VoteFn | null }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null as string | null);
  const decided = tally.state === "DECIDED";
  const canVote = Boolean(vote) && tally.open;

  async function pick(questionIndex: number, option: string, mine: boolean) {
    if (!vote || pending) return;
    setPending(true);
    setError(null);
    try {
      setError(await vote(questionIndex, mine ? null : option));
    } catch {
      setError("Could not save your vote.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div data-testid="decision-tally" className="mt-2 space-y-3">
      {tally.questions.map((q, questionIndex) => {
        const total = q.options.reduce((sum, o) => sum + o.count, 0);
        return (
          <fieldset key={questionIndex} className="min-w-0">
            <legend className="mb-1 text-sm font-medium text-text-primary">{q.question}</legend>
            <ul className="space-y-1.5">
              {q.options.map((o) => {
                const mine = q.myVote === o.label;
                const share = total > 0 ? Math.round((o.count / total) * 100) : 0;
                return (
                  <li key={o.label}>
                    <button
                      type="button"
                      data-testid="decision-option"
                      aria-pressed={mine}
                      disabled={!canVote || pending}
                      onClick={() => void pick(questionIndex, o.label, mine)}
                      className={"relative flex min-h-9 w-full items-center justify-between gap-3 overflow-hidden rounded-md border px-3 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default " + (mine ? "border-border-interactive" : "border-border-default")}
                    >
                      <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-surface-inset" style={{ width: share + "%" }} />
                      <span className="relative min-w-0 break-words text-text-primary">{o.label}{mine ? " (your vote)" : ""}</span>
                      <span className="relative shrink-0 tabular-nums text-text-secondary">{o.count}</span>
                    </button>
                    {decided && o.voters && o.voters.length > 0 ? (
                      <p className="mt-0.5 px-1 text-xs text-text-subtle">{o.voters.join(", ")}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
      <p className="text-xs text-text-subtle">
        {decided
          ? "Decided. Votes were advisory."
          : canVote
            ? "Votes are advisory and anonymous until the decision is recorded."
            : tally.open
              ? "Only workspace members can vote. Votes are advisory."
              : "Voting is closed."}
      </p>
      {error ? <p role="alert" data-testid="decision-vote-error" className="text-xs text-status-danger">{error}</p> : null}
    </div>
  );
}
