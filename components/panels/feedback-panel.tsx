"use client";

import {
  useEntityDetail,
  PanelSkeleton,
  PanelError,
  PanelContainer,
  FullPageLink,
  PanelTitle,
  EditableText,
  StatusSelect,
  Section,
  Field,
  RelationList,
  type RelationItem,
  type EditContext,
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

const STATUS: Record<string, { label: string; className: string }> = {
  OPEN: { label: "Open", className: "bg-slate-100 text-slate-600" },
  UNDER_REVIEW: { label: "Under review", className: "bg-yellow-100 text-yellow-700" },
  PLANNED: { label: "Planned", className: "bg-blue-100 text-blue-700" },
  IN_PROGRESS: { label: "In progress", className: "bg-indigo-100 text-indigo-700" },
  COMPLETED: { label: "Completed", className: "bg-green-100 text-green-700" },
  DECLINED: { label: "Declined", className: "bg-red-100 text-red-600" },
};

const STATUS_ORDER = ["OPEN", "UNDER_REVIEW", "PLANNED", "IN_PROGRESS", "COMPLETED", "DECLINED"] as const;

export function FeedbackPanel({
  id,
  orgSlug,
  workspaceSlug,
}: {
  id: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const { data, error, mutate } = useEntityDetail<FeedbackData>(
    "feedback",
    id,
    orgSlug,
    workspaceSlug
  );

  if (error) return <PanelError label="feedback" />;
  if (!data) return <PanelSkeleton />;

  const edit: EditContext = {
    type: "feedback",
    id,
    orgSlug,
    workspaceSlug,
    onSaved: (d) => mutate(d as FeedbackData),
  };

  const oppItems: RelationItem[] = data.opportunity
    ? [{ type: "opportunity", id: data.opportunity.id, title: data.opportunity.title }]
    : [];

  return (
    <PanelContainer>
      <FullPageLink href={`/${orgSlug}/${workspaceSlug}/feedback`} />

      <PanelTitle
        title={data.title}
        status={TYPE[data.type] ?? { label: data.type }}
        edit={edit}
      />

      <EditableText
        value={data.description}
        field="description"
        edit={edit}
        multiline
        placeholder="Add a description…"
        className="text-sm text-foreground/80 leading-relaxed"
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Status
          </p>
          <StatusSelect
            value={data.status}
            field="status"
            options={STATUS_ORDER}
            map={STATUS}
            edit={edit}
          />
        </div>
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
