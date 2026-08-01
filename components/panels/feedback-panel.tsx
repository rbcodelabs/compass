"use client";

import {
  useEntityDetail,
  PanelSkeleton,
  PanelError,
  PanelContainer,
  FullPageLink,
  PanelTitle,
  Section,
  Field,
  RelationList,
  type RelationItem,
} from "./panel-parts";

type FeedbackData = {
  id: string;
  title: string;
  description: string | null;
  type: string;
  status: string;
  voteCount: number;
  submitterName: string | null;
  opportunity: { id: string; title: string } | null;
  attachments: Array<{
    id: string;
    url: string;
    filename: string;
    fileType: string;
    fileSize: number;
  }>;
  _count: { votes: number };
};

const TYPE: Record<string, { label: string; className: string }> = {
  BUG: { label: "Bug", className: "bg-red-100 text-red-700" },
  IDEA: { label: "Idea", className: "bg-violet-100 text-violet-700" },
};

export function FeedbackPanel({
  id,
  orgSlug,
  workspaceSlug,
}: {
  id: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const { data, error } = useEntityDetail<FeedbackData>(
    "feedback",
    id,
    orgSlug,
    workspaceSlug
  );

  if (error) return <PanelError label="feedback" />;
  if (!data) return <PanelSkeleton />;

  const oppItems: RelationItem[] = data.opportunity
    ? [{ type: "opportunity", id: data.opportunity.id, title: data.opportunity.title }]
    : [];

  return (
    <PanelContainer>
      <FullPageLink href={`/${orgSlug}/${workspaceSlug}/feedback`} />

      <PanelTitle title={data.title} status={TYPE[data.type] ?? { label: data.type }} />

      {data.description && (
        <p className="text-sm text-foreground/80 leading-relaxed">{data.description}</p>
      )}

      <div className="flex flex-col gap-3">
        <Field label="Status">{data.status}</Field>
        <Field label="Votes">{data.voteCount}</Field>
        {data.submitterName && <Field label="Submitted by">{data.submitterName}</Field>}
      </div>

      <Section label="Linked Opportunity">
        <RelationList items={oppItems} empty="Not linked to an opportunity." />
      </Section>

      <Section label="Attachments" count={data.attachments.length}>
        {data.attachments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No attachments.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {data.attachments.map((a) => (
              <a
                key={a.id}
                href={a.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-indigo-600 hover:underline truncate"
              >
                {a.filename}
              </a>
            ))}
          </div>
        )}
      </Section>
    </PanelContainer>
  );
}
