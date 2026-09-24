"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Check, ChevronDown, Clock3, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { groupUpdates, updateHeadline } from "@/lib/workspace-updates-model";
import type { UpdatesPage } from "@/lib/workspace-updates";
import {
  loadUpdates,
  markCaughtUp,
  undoCaughtUp,
} from "@/app/[orgSlug]/[workspaceSlug]/updates/actions";

export function UpdatesFeed({
  orgSlug,
  workspaceSlug,
  initial,
}: {
  orgSlug: string;
  workspaceSlug: string;
  initial: UpdatesPage;
}) {
  const [page, setPage] = useState(initial);
  const [mode, setMode] = useState<"unread" | "week">("unread");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [pending, startTransition] = useTransition();
  const groups = groupUpdates(page.items);
  function run(action: () => Promise<void>) {
    startTransition(async () => {
      try {
        await action();
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : "Could not update your catch-up state. Please try again.",
        );
      }
    });
  }
  function changeMode(next: "unread" | "week") {
    run(async () => {
      const result = await loadUpdates(orgSlug, workspaceSlug, next);
      setPage(result);
      setMode(next);
      setNotice("");
    });
  }
  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8 md:px-10 md:py-12">
      <header className="mb-8">
        <p className="mb-2 text-xs font-medium tracking-widest text-text-subtle">
          YOUR WORKSPACE, IN CONTEXT
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-text-primary">
          Updates
        </h1>
        <p className="mt-2 text-text-secondary">
          A little context. Back up to speed.
        </p>
      </header>
      {!page.available ? (
        <section className="rounded-xl border border-border bg-surface-card p-8">
          <h2 className="font-semibold">Updates is getting ready</h2>
          <p className="mt-2 text-sm text-text-secondary">
            Your workspace will start collecting updates when this feature is
            enabled. Existing work is available from the navigation.
          </p>
        </section>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div
              className="flex gap-1 rounded-lg bg-surface-inset p-1"
              role="group"
              aria-label="Update period"
            >
              <Button
                size="sm"
                variant={mode === "unread" ? "secondary" : "ghost"}
                aria-pressed={mode === "unread"}
                disabled={pending}
                onClick={() => changeMode("unread")}
              >
                Since last catch-up
              </Button>
              <Button
                size="sm"
                variant={mode === "week" ? "secondary" : "ghost"}
                aria-pressed={mode === "week"}
                disabled={pending}
                onClick={() => changeMode("week")}
              >
                Past week
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => changeMode(mode)}
            >
              Refresh
            </Button>
          </div>
          <section
            aria-label="Catch-up summary"
            className="mb-6 flex items-center justify-between gap-4 rounded-xl border border-border bg-surface-card p-5"
          >
            <div>
              <h2 className="font-medium text-text-primary">
                {groups.length
                  ? `${groups.length}${page.cursor ? "+" : ""} ${groups.length === 1 ? "story" : "stories"} ${mode === "unread" ? "to catch up on" : "this week"}`
                  : page.cursor
                    ? "Loading your remaining updates"
                    : mode === "unread"
                      ? "You’re caught up."
                      : "No updates this week"}
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                Progress, learning, and decisions across your workspace.
              </p>
            </div>
            <Clock3
              className="h-5 w-5 shrink-0 text-text-subtle"
              aria-hidden="true"
            />
          </section>
          {!groups.length && !page.cursor && (
            <section className="py-12 text-center">
              <Check
                className="mx-auto mb-4 h-8 w-8 text-primary"
                aria-hidden="true"
              />
              <h2 className="text-xl font-medium">
                {mode === "unread"
                  ? "You’re caught up."
                  : "A quiet week so far."}
              </h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-text-secondary">
                New meaningful changes will appear here. Tasks and decisions
                keep their own status.
              </p>
              {mode === "unread" && (
                <Button
                  variant="outline"
                  className="mt-5"
                  onClick={() => changeMode("week")}
                  disabled={pending}
                >
                  Browse this week’s updates
                </Button>
              )}
            </section>
          )}
          <section aria-label="Grouped updates" className="space-y-4">
            {groups.map((group) => {
              const latest = group.items[0];
              return (
                <article
                  key={group.id}
                  className="overflow-hidden rounded-xl border border-border bg-surface-card"
                >
                  <div className="p-5 md:p-6">
                    <div className="mb-3 flex items-center justify-between gap-3 text-xs text-text-subtle">
                      <Badge variant="secondary">
                        {["TASK", "ROADMAP_ITEM"].includes(latest.groupType)
                          ? "Delivery"
                          : latest.groupType === "EXPERIMENT"
                            ? "Learning"
                            : latest.groupType === "DECISION"
                              ? "Decisions"
                              : latest.kind === "COMMENT_ADDED"
                                ? "Discussion"
                                : "Discovery"}
                      </Badge>
                      <time dateTime={latest.createdAt}>
                        {new Date(latest.createdAt).toLocaleDateString(
                          "en-US",
                          { month: "short", day: "numeric", timeZone: "UTC" },
                        )}
                      </time>
                    </div>
                    <h2 className="break-words text-lg font-semibold text-text-primary">
                      <Link href={latest.groupHref} className="hover:underline">
                        {latest.groupTitle}
                      </Link>
                    </h2>
                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                      {updateHeadline(latest)}
                      {latest.entityId !== latest.groupId
                        ? ` · ${latest.title}`
                        : ""}
                      .{" "}
                      {group.items.length > 1
                        ? `${group.items.length} related changes in this view.`
                        : ""}
                    </p>
                    <Link
                      href={latest.href}
                      className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                    >
                      View work{" "}
                      <ArrowUpRight
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      />
                    </Link>
                  </div>
                  <Collapsible className="border-t border-border">
                    <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-5 py-3 text-sm text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary md:px-6">
                      <ChevronDown className="h-4 w-4" aria-hidden="true" />
                      Behind this update{" "}
                      <span className="ml-auto text-xs">
                        {group.items.length}{" "}
                        {group.items.length === 1 ? "change" : "changes"}
                      </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <ol className="space-y-4 border-t border-border bg-surface-inset px-5 py-4 md:px-6">
                        {group.items.map((item) => (
                          <li key={item.id} className="text-sm">
                            <Link
                              href={item.href}
                              className="font-medium text-text-primary hover:underline"
                            >
                              {item.title}
                            </Link>
                            <p className="mt-1 text-text-secondary">
                              {updateHeadline(item)}
                            </p>
                            <p className="mt-1 text-xs text-text-subtle">
                              {item.actor} ·{" "}
                              <time dateTime={item.createdAt}>
                                {new Date(item.createdAt).toLocaleString(
                                  "en-US",
                                  { timeZone: "UTC" },
                                )}{" "}
                                UTC
                              </time>
                            </p>
                          </li>
                        ))}
                      </ol>
                    </CollapsibleContent>
                  </Collapsible>
                </article>
              );
            })}
          </section>
          {page.cursor && (
            <Button
              variant="outline"
              className="mt-6 w-full"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const next = await loadUpdates(
                    orgSlug,
                    workspaceSlug,
                    mode,
                    page.cursor!,
                  );
                  setPage({ ...next, items: [...page.items, ...next.items] });
                })
              }
            >
              Load more updates
            </Button>
          )}
          {mode === "unread" && groups.length > 0 && (
            <footer className="mt-8 flex flex-col items-start justify-between gap-4 border-t border-border pt-6 sm:flex-row sm:items-center">
              <div>
                <p className="font-medium">
                  {page.cursor
                    ? "There’s more to catch up on."
                    : "That’s your workspace in view."}
                </p>
                <p className="mt-1 text-sm text-text-secondary">
                  {page.cursor
                    ? "Load the remaining updates before marking caught up."
                    : "Mark this snapshot caught up. New arrivals stay unread."}
                </p>
              </div>
              <Button
                disabled={pending || !page.markToken}
                onClick={() =>
                  run(async () => {
                    const result = await markCaughtUp(
                      orgSlug,
                      workspaceSlug,
                      page.markToken!,
                    );
                    if (!result.ok) {
                      setReceipt(null);
                      setPage(
                        await loadUpdates(orgSlug, workspaceSlug, "unread"),
                      );
                      throw new Error(result.error);
                    }
                    setReceipt(result.receipt);
                    setPage({
                      ...page,
                      items: [],
                      markToken: null,
                      readRevision: result.readRevision,
                    });
                    setNotice("Updates marked caught up");
                  })
                }
              >
                <Check className="h-4 w-4" />
                Mark caught up
              </Button>
            </footer>
          )}
          <p className="mt-8 text-xs leading-relaxed text-text-subtle">
            Updates capture starts when enabled. Earlier work is not
            reconstructed. Changes are grouped by their explicit relationships
            and shown newest first.
          </p>
        </>
      )}
      <div
        role="status"
        aria-live="polite"
        className="mt-4 text-sm text-text-secondary"
      >
        {pending ? "Loading updates…" : notice}
      </div>
      {receipt && (
        <div className="sticky bottom-20 mt-5 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-card p-4 shadow-sm md:bottom-4">
          <span className="text-sm">Updates marked caught up</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() =>
              run(async () => {
                try {
                  const result = await undoCaughtUp(
                    orgSlug,
                    workspaceSlug,
                    receipt,
                  );
                  if (!result.ok) throw new Error(result.error);
                } catch (error) {
                  setReceipt(null);
                  setPage(await loadUpdates(orgSlug, workspaceSlug, "unread"));
                  setMode("unread");
                  throw error;
                }
                setReceipt(null);
                setPage(await loadUpdates(orgSlug, workspaceSlug, "unread"));
                setMode("unread");
                setNotice("Catch-up undone");
              })
            }
          >
            Undo
          </Button>
        </div>
      )}
    </main>
  );
}
