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
import {
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_OPTIONS,
  FEEDBACK_TYPE_OPTIONS,
} from "@/lib/feedback-meta";

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

// Labels and tones come from lib/feedback-meta, the single source shared with
// the feedback grid. These used to be a local copy of the same maps whose red
// and violet shades had drifted one step darker than the feedback board's.
const TYPE: Record<string, { label: string; className: string }> = FEEDBACK_TYPE_OPTIONS;

const STATUS: Record<string, { label: string; className: string }> = FEEDBACK_STATUS_OPTIONS;

const STATUS_ORDER = FEEDBACK_STATUSES;

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
