"use client";

/**
 * The shared task detail body, mounted in two places (per the plan's
 * "one component, two mount points" decision):
 *   1. Inside PanelShell's Sheet, as the "task" panel type — sidebar on
 *      desktop, fullscreen on mobile (PanelShell's existing responsive Sheet
 *      styling, "for free").
 *   2. Inside /tasks/[taskId]/page.tsx, full width, wrapped in that page's
 *      own breadcrumb chrome.
 *
 * Composed from the same panel-parts.tsx primitives every other entity panel
 * uses (PanelTitle/Section/Field/EditableText/StatusSelect/
 * RelationList), plus two new inline field components for assignee and due
 * date, and the existing TaskLinksPanel/CustomFieldsPanel/AddSubtaskForm
 * reused with compact task styling. No tabs: work comes before secondary properties.
 */
import { Badge } from "@/components/ui/badge";
import {
  Combobox,
  ComboboxContent,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import {
  useEntityDetail,
  patchEntityField,
  PanelSkeleton,
  PanelError,
  PanelTitle,
  Section,
  Field,
  RelationList,
  EditableText,
  StatusSelect,
  type EditContext,
  type StatusOption,
} from "@/components/panels/panel-parts";
import { usePanelContext } from "@/components/panels/panel-context";
import { Discussion } from "@/components/comments/discussion";
import { InlineAssigneeField } from "./inline-assignee-field";
import { InlineDateField } from "./inline-date-field";
import { TaskLinksPanel } from "./task-links-panel";
import { AddSubtaskForm } from "./add-subtask-form";
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel";
import { TASK_STATUS_LABELS, TASK_PRIORITY_LABELS } from "@/lib/task-meta";
import type { LinkableTargets } from "./link-task-dialog";
import type { TaskCardData } from "./task-card";
import type { ResolvedTaskAssignee } from "@/lib/task-assignment";
import type {
  TaskStatus,
  TaskPriority,
  TaskLinkedType,
  SquadData,
  MemberData,
  CustomFieldDefinitionData,
  CustomFieldValue,
} from "@/lib/types";

type TaskLink = { id: string; linkedType: TaskLinkedType; linkedId: string; linkedTitle: string };

type SubtaskData = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  sortOrder: number;
  squadId: string | null;
  squad: { id: string; name: string; color: string } | null;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
  assignee?: ResolvedTaskAssignee | null;
  ownerName: string | null;
  storyPoints: number | null;
  dueDate: string | null;
  iteration: string | null;
  parentTaskId: string | null;
  links: TaskLink[];
  _count: { subtasks: number };
};

type TaskDetailData = {
  id: string;
  workspaceId: string;
  squadId: string | null;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
  assignee?: ResolvedTaskAssignee | null;
  ownerName: string | null;
  storyPoints: number | null;
  dueDate: string | null;
  iteration: string | null;
  sortOrder: number;
  squad: { id: string; name: string; color: string } | null;
  parentTask: { id: string; title: string } | null;
  links: TaskLink[];
  subtasks: SubtaskData[];
  squads: SquadData[];
  members: MemberData[];
  linkableTargets: LinkableTargets;
  customFields: Array<CustomFieldDefinitionData & { currentValue: CustomFieldValue }>;
};

// Semantic status-badge tokens (bg-status-*-surface / text-status-*, defined
// in components/patterns/status-badge.tsx) rather than raw Tailwind palette
// classes — this file is new since the design-token refactor (12dbbac) landed,
// so it has no raw-color baseline allowance and must be token-clean from the
// start. Matches task-card.tsx's PRIORITY_STATUS mapping for priority.
const STATUS_MAP: Record<TaskStatus, StatusOption> = {
  BACKLOG: { label: TASK_STATUS_LABELS.BACKLOG, className: "bg-status-neutral-surface text-status-neutral" },
  TODO: { label: TASK_STATUS_LABELS.TODO, className: "bg-status-info-surface text-status-info" },
  IN_PROGRESS: { label: TASK_STATUS_LABELS.IN_PROGRESS, className: "bg-status-info-surface text-status-info" },
  BLOCKED: { label: TASK_STATUS_LABELS.BLOCKED, className: "bg-status-danger-surface text-status-danger" },
  IN_REVIEW: { label: TASK_STATUS_LABELS.IN_REVIEW, className: "bg-status-warning-surface text-status-warning" },
  DONE: { label: TASK_STATUS_LABELS.DONE, className: "bg-status-success-surface text-status-success" },
  CANCELLED: { label: TASK_STATUS_LABELS.CANCELLED, className: "bg-status-neutral-surface text-status-neutral" },
};
const STATUS_ORDER = Object.keys(STATUS_MAP) as TaskStatus[];

const PRIORITY_MAP: Record<TaskPriority, StatusOption> = {
  URGENT: { label: TASK_PRIORITY_LABELS.URGENT, className: "bg-status-danger-surface text-status-danger" },
  HIGH: { label: TASK_PRIORITY_LABELS.HIGH, className: "bg-status-warning-surface text-status-warning" },
  MEDIUM: { label: TASK_PRIORITY_LABELS.MEDIUM, className: "bg-status-info-surface text-status-info" },
  LOW: { label: TASK_PRIORITY_LABELS.LOW, className: "bg-status-neutral-surface text-status-neutral" },
};
const PRIORITY_ORDER = Object.keys(PRIORITY_MAP) as TaskPriority[];

const NONE_SQUAD = "__none__";

/** Converts the panel's full task shape into the compact card shape
 * TaskBoard/TaskListView/TaskColumn keep in their own local state, so a
 * panel edit can be broadcast via notifyEntityMutated. */
function toCardData(d: TaskDetailData): TaskCardData {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    status: d.status,
    priority: d.priority,
    sortOrder: d.sortOrder,
    squadId: d.squadId,
    squad: d.squad,
    assigneeUserId: d.assigneeUserId,
    assigneeAgentId: d.assigneeAgentId,
    assignee: d.assignee,
    ownerName: d.ownerName,
    storyPoints: d.storyPoints,
    dueDate: d.dueDate,
    iteration: d.iteration,
    parentTaskId: d.parentTaskId,
    subtaskCount: d.subtasks.length,
    links: d.links,
  };
}

/** Inline squad picker — mirrors squad-picker.tsx's rendering, but writes
 * through patchEntityField (squadId) so it flows through the same
 * mutation/notify path as every other field in this component, rather than
 * SquadPicker's separate assignSquad server action. */
function TaskSquadField({ data, edit }: { data: TaskDetailData; edit: EditContext }) {
  if (data.squads.length === 0) return null;

  async function handleChange(value: string | null) {
    const next = !value || value === NONE_SQUAD ? null : value;
    if (next === data.squadId) return;
    const res = await patchEntityField(edit.type, edit.id, edit.orgSlug, edit.workspaceSlug, "squadId", next);
    edit.onSaved(res.data);
  }

  const activeSquad = data.squads.find((s) => s.id === data.squadId);

  return (
    <Combobox
      items={[
        { value: NONE_SQUAD, label: "No squad" },
        ...data.squads.map((squad) => ({
          value: squad.id,
          label: squad.name,
          render: (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full shrink-0 inline-block" style={{ backgroundColor: squad.color }} />
              {squad.name}
            </span>
          ),
        })),
      ]}
      value={data.squadId ?? NONE_SQUAD}
      onValueChange={handleChange}
    >
      <ComboboxTrigger aria-label="Squad" className="h-8 min-w-0 text-sm w-full justify-between">
        {activeSquad ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: activeSquad.color }} />
            <ComboboxValue className="truncate" />
          </span>
        ) : (
          <ComboboxValue placeholder="No squad" />
        )}
      </ComboboxTrigger>
      <ComboboxContent />
    </Combobox>
  );
}

type Props = {
  taskId: string;
  orgSlug: string;
  workspaceSlug: string;
  variant: "panel" | "page";
};

export function TaskDetail({ taskId, orgSlug, workspaceSlug, variant }: Props) {
  const { openPanel, notifyEntityMutated } = usePanelContext();
  const { data, error, mutate, refresh } = useEntityDetail<TaskDetailData>(
    "task",
    taskId,
    orgSlug,
    workspaceSlug
  );

  if (error) return <PanelError label="task" />;
  if (!data) return <PanelSkeleton />;

  const detailPath = `/${orgSlug}/${workspaceSlug}/tasks/${taskId}`;

  const edit: EditContext = {
    type: "task",
    id: taskId,
    orgSlug,
    workspaceSlug,
    onSaved: (d) => {
      const next = d as TaskDetailData;
      mutate(next);
      notifyEntityMutated("task", taskId, { task: toCardData(next) });
    },
  };

  return (
    <div data-slot="task-detail" className={`flex min-w-0 flex-col gap-3 break-words pb-8 ${variant === "panel" ? "px-5" : ""}`}>
      <PanelTitle
        title={data.title}
        edit={edit}
      />
      <div aria-label="Task summary" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <StatusSelect
          value={data.status} field="status" options={STATUS_ORDER}
          map={STATUS_MAP} edit={edit} label="Status"
        />
        <StatusSelect
          value={data.priority} field="priority" options={PRIORITY_ORDER}
          map={PRIORITY_MAP} edit={edit} label="Priority"
        />
        <div className="min-w-0 w-fit max-w-40">
          <InlineAssigneeField
            assigneeUserId={data.assigneeUserId}
            assigneeAgentId={data.assigneeAgentId}
            current={data.assignee}
            ownerName={data.ownerName}
            members={data.members}
            edit={edit}
            compact
          />
        </div>
        <InlineDateField value={data.dueDate} field="dueDate" edit={edit} placeholder="Set due date" compact />
      </div>
      <EditableText
        value={data.description}
        field="description"
        edit={edit}
        multiline
        placeholder="Add a description…"
        className="text-sm text-foreground/80 leading-relaxed"
      />

      {data.subtasks.length > 0 ? (
        <Section label="Subtasks" count={data.subtasks.length}>
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              {data.subtasks.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => openPanel("task", s.id)}
                  className="group flex items-center gap-2 rounded-md -mx-2 px-2 py-1.5 text-left hover:bg-muted transition-colors"
                >
                  <Badge className={`${STATUS_MAP[s.status]?.className ?? "bg-status-neutral-surface text-status-neutral"} shrink-0 text-xs`}>
                    {STATUS_MAP[s.status]?.label ?? s.status}
                  </Badge>
                  <span className="min-w-0 flex-1 text-sm leading-snug truncate">{s.title}</span>
                </button>
              ))}
            </div>
            <AddSubtaskForm
              workspaceId={data.workspaceId}
              parentTaskId={taskId}
              members={data.members}
              revalidatePathStr={detailPath}
              onAdd={() => refresh()}
            />
          </div>
        </Section>
      ) : (
        <AddSubtaskForm
          workspaceId={data.workspaceId} parentTaskId={taskId}
          members={data.members} revalidatePathStr={detailPath} onAdd={() => refresh()}
        />
      )}

      <Section label="More properties" collapsible panelType="task">
        <Field label="Story points" layout="row">
          <EditableText
            value={data.storyPoints != null ? String(data.storyPoints) : null}
            field="storyPoints" edit={edit} type="number" placeholder="Add points…"
          />
        </Field>
        <Field label="Iteration" layout="row">
          <EditableText value={data.iteration} field="iteration" edit={edit} placeholder="e.g. Sprint 24" />
        </Field>
        {data.squads.length > 0 && (
          <Field label="Squad" layout="row">
            <TaskSquadField data={data} edit={edit} />
          </Field>
        )}
        <Field label="External owner" layout="row">
          <EditableText value={data.ownerName} field="ownerName" edit={edit} placeholder="Add external owner…" />
        </Field>
      </Section>

      {data.parentTask && (
        <Section label="Parent task">
          <RelationList items={[{ type: "task", id: data.parentTask.id, title: data.parentTask.title }]} empty="" />
        </Section>
      )}

      <Section label="Links" count={data.links.length}>
        <TaskLinksPanel
          taskId={taskId}
          initialLinks={data.links}
          revalidatePathStr={detailPath}
          linkableTargets={data.linkableTargets}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      </Section>

      {data.customFields.length > 0 && (
        <Section label="Details">
          <CustomFieldsPanel fields={data.customFields} objectId={taskId} revalidatePathStr={detailPath} onSaved={refresh} compact />
        </Section>
      )}

      <Discussion targetType="TASK" targetId={taskId} />
    </div>
  );
}
