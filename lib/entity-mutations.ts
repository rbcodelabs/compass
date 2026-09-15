/**
 * Scoped single-field edits for the detail panels — the write counterpart to
 * lib/entity-detail.ts. A panel can update an allowlisted field (title,
 * description, or the entity's primary enum) and the change is constrained to
 * the caller's workspace using the same `entityScopeWhere` boundary the reads
 * use, so a write can no more cross workspaces than a read can.
 *
 * Only fields in EDIT_CONFIG are writable; anything else is rejected. Enum
 * fields (status / horizon) are validated against their allowed values. This
 * keeps the surface deliberately small — the panel is for quick edits, not a
 * general-purpose entity editor.
 */
import getPrisma from "@/lib/db";
import { entityScopeWhere, type EntityType } from "@/lib/entity-detail";
import { SETTABLE_HORIZONS } from "@/lib/roadmap";
import { assignmentUpdate, type TaskAssignee } from "@/lib/task-assignment";
import type { TaskPriority, TaskStatus } from "@/lib/types";

type MutationActor = { kind: "USER" | "SERVICE" | "ANONYMOUS" | "SYSTEM"; id: string | null };

type EnumFieldConfig = { field: "status" | "horizon"; options: readonly string[] };

export type EntityEditConfig = {
  /** Prisma model accessor name (differs from EntityType only for feedback). */
  model: string;
  title: boolean;
  description: boolean;
  /** The entity's primary single-select field, if it has one. */
  enum?: EnumFieldConfig;
};

/**
 * EDIT_CONFIG's title/description/one-enum shape covers 8 of the 9 panel
 * entity types. Task is excluded on purpose — see updateTaskField below —
 * so EDIT_CONFIG stays a Record over the *other* eight instead of forcing a
 * dummy entry that's never read.
 */
type LegacyEntityType = Exclude<EntityType, "task">;

const OBJECTIVE_STATUS = ["ON_TRACK", "AT_RISK", "OFF_TRACK", "COMPLETE"] as const;
const OPPORTUNITY_STATUS = ["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "ARCHIVED"] as const;
const SOLUTION_STATUS = ["IDEA", "VALIDATED", "IN_DELIVERY", "SHIPPED", "KILLED"] as const;
const ASSUMPTION_STATUS = ["UNTESTED", "TESTING", "VALIDATED", "INVALIDATED"] as const;
const EXPERIMENT_STATUS = ["DESIGNING", "RUNNING", "COMPLETE", "KILLED"] as const;
const FEEDBACK_STATUS = ["OPEN", "UNDER_REVIEW", "PLANNED", "IN_PROGRESS", "COMPLETED", "DECLINED"] as const;
// Horizons the generic single-field edit may set. LAUNCHING is deliberately
// absent — entering it must go through setLaunchTier (which creates the
// checklist transactionally), never a bare horizon PATCH. See the explicit
// guard in updateEntityField.
const ROADMAP_HORIZON = SETTABLE_HORIZONS;

/**
 * What each entity type exposes for inline editing in the panel. Exported so
 * the client renders exactly the controls the server will accept — no drift
 * between what a panel offers and what the PATCH validates.
 */
export const EDIT_CONFIG: Record<LegacyEntityType, EntityEditConfig> = {
  objective: { model: "objective", title: true, description: true, enum: { field: "status", options: OBJECTIVE_STATUS } },
  keyResult: { model: "keyResult", title: true, description: false },
  opportunity: { model: "opportunity", title: true, description: true, enum: { field: "status", options: OPPORTUNITY_STATUS } },
  solution: { model: "solution", title: true, description: true, enum: { field: "status", options: SOLUTION_STATUS } },
  assumption: { model: "assumption", title: true, description: true, enum: { field: "status", options: ASSUMPTION_STATUS } },
  experiment: { model: "experiment", title: true, description: false, enum: { field: "status", options: EXPERIMENT_STATUS } },
  roadmapItem: { model: "roadmapItem", title: true, description: true, enum: { field: "horizon", options: ROADMAP_HORIZON } },
  feedback: { model: "feedbackItem", title: true, description: true, enum: { field: "status", options: FEEDBACK_STATUS } },
};

export const TITLE_MAX_LENGTH = 255;

export type UpdateResult =
  | { ok: true }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Validate `field`/`value` against EDIT_CONFIG for `type`, then apply the edit
 * scoped to `workspaceId`. Returns a 404 result if the entity isn't in the
 * workspace (verified before the write), a 400 result on invalid input.
 */
export async function updateEntityField(
  type: EntityType,
  id: string,
  workspaceId: string,
  field: string,
  value: unknown,
  _actor: MutationActor = { kind: "SYSTEM", id: null },
): Promise<UpdateResult> {
  void _actor;
  // Task has ~9 editable fields (two enums, a relation, a date, a number) —
  // dispatched to its own allowlist rather than forcing EDIT_CONFIG's
  // title/description/one-enum shape to fit it. See updateTaskField.
  if (type === "task") return updateTaskField(id, workspaceId, field, value);

  const config = EDIT_CONFIG[type];

  // ── Validate the field is editable and coerce the value ──────────────────
  let data: Record<string, unknown>;
  if (field === "title") {
    if (!config.title) return { ok: false, status: 400, error: "Title is not editable" };
    if (typeof value !== "string" || value.trim().length === 0) {
      return { ok: false, status: 400, error: "Title is required" };
    }
    if (value.trim().length > TITLE_MAX_LENGTH) {
      return { ok: false, status: 400, error: `Title must be ${TITLE_MAX_LENGTH} characters or fewer` };
    }
    data = { title: value.trim() };
  } else if (field === "description") {
    if (!config.description) return { ok: false, status: 400, error: "Description is not editable" };
    if (value !== null && typeof value !== "string") {
      return { ok: false, status: 400, error: "Description must be text" };
    }
    const trimmed = typeof value === "string" ? value.trim() : "";
    data = { description: trimmed.length > 0 ? trimmed : null };
  } else if (config.enum && field === config.enum.field) {
    // Load-bearing guard: LAUNCHING may only be entered via setLaunchTier,
    // which creates the launch checklist in the same transaction. A bare
    // horizon write here would flip the item to LAUNCHING with no checklist,
    // bypassing that invariant — reject it explicitly with a clear message
    // (it's also absent from SETTABLE_HORIZONS, but say why).
    if (type === "roadmapItem" && field === "horizon" && value === "LAUNCHING") {
      return {
        ok: false,
        status: 400,
        error: "Set a launch tier to move an item into LAUNCHING — it can't be set directly.",
      };
    }
    if (typeof value !== "string" || !config.enum.options.includes(value)) {
      return { ok: false, status: 400, error: `Invalid ${field}` };
    }
    data = { [field]: value };
  } else {
    return { ok: false, status: 400, error: `Field "${field}" is not editable` };
  }

  // DSQL has no @updatedAt trigger — every update must set it explicitly.
  data.updatedAt = new Date();

  // ── Scoped write: confirm the entity is in the workspace, then update ─────
  // updateMany's where doesn't support the relation filters the indirect
  // entities need, so verify with the scoped findFirst first, then update by
  // id. Same access boundary as reads (entityScopeWhere).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = (getPrisma() as any)[config.model];
  const exists = await model.findFirst({
    where: entityScopeWhere(type, id, workspaceId),
    select: { id: true },
  });
  if (!exists) return { ok: false, status: 404, error: "Not found" };

  await model.update({ where: { id }, data });
  return { ok: true };
}

const TASK_STATUSES: readonly TaskStatus[] = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "BLOCKED",
  "IN_REVIEW",
  "DONE",
  "CANCELLED",
];
const TASK_PRIORITIES: readonly TaskPriority[] = ["URGENT", "HIGH", "MEDIUM", "LOW"];

/**
 * Task's own field-edit path (see the `updateEntityField` dispatch above).
 * Task is directly workspace-owned — no parent-chain scoping needed, unlike
 * e.g. Solution/Assumption — so it verifies with `{ id, workspaceId }` via
 * the same `entityScopeWhere("task", …)` boundary the reads use, then writes
 * by id. Same "verify with scoped findFirst, then update by id" shape as
 * updateEntityField, same explicit `updatedAt` (DSQL has no update trigger).
 */
async function updateTaskField(
  id: string,
  workspaceId: string,
  field: string,
  value: unknown
): Promise<UpdateResult> {
  let data: Record<string, unknown>;

  switch (field) {
    case "title": {
      if (typeof value !== "string" || value.trim().length === 0) {
        return { ok: false, status: 400, error: "Title is required" };
      }
      if (value.trim().length > TITLE_MAX_LENGTH) {
        return { ok: false, status: 400, error: `Title must be ${TITLE_MAX_LENGTH} characters or fewer` };
      }
      data = { title: value.trim() };
      break;
    }
    case "description": {
      if (value !== null && typeof value !== "string") {
        return { ok: false, status: 400, error: "Description must be text" };
      }
      const trimmed = typeof value === "string" ? value.trim() : "";
      data = { description: trimmed.length > 0 ? trimmed : null };
      break;
    }
    case "status": {
      if (typeof value !== "string" || !TASK_STATUSES.includes(value as TaskStatus)) {
        return { ok: false, status: 400, error: "Invalid status" };
      }
      data = { status: value };
      break;
    }
    case "priority": {
      if (typeof value !== "string" || !TASK_PRIORITIES.includes(value as TaskPriority)) {
        return { ok: false, status: 400, error: "Invalid priority" };
      }
      data = { priority: value };
      break;
    }
    case "assigneeUserId": {
      if (value !== null && typeof value !== "string") {
        return { ok: false, status: 400, error: "assigneeUserId must be a string or null" };
      }
      data = { assigneeUserId: value };
      break;
    }
    case "assignee": {
      let assignee: TaskAssignee;
      if (value === null) {
        assignee = null;
      } else if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        "id" in value &&
        ((value as { type: unknown }).type === "USER" || (value as { type: unknown }).type === "AGENT") &&
        typeof (value as { id: unknown }).id === "string"
      ) {
        assignee = value as TaskAssignee;
      } else {
        return { ok: false, status: 400, error: "Invalid assignee" };
      }
      try {
        data = await assignmentUpdate(workspaceId, { assignee });
      } catch (error) {
        return { ok: false, status: 400, error: error instanceof Error ? error.message : "Invalid assignee" };
      }
      break;
    }
    case "ownerName": {
      if (value !== null && typeof value !== "string") {
        return { ok: false, status: 400, error: "ownerName must be text" };
      }
      const trimmed = typeof value === "string" ? value.trim() : "";
      data = { ownerName: trimmed.length > 0 ? trimmed : null };
      break;
    }
    case "storyPoints": {
      if (value === null) {
        data = { storyPoints: null };
      } else if (typeof value === "number" && Number.isFinite(value)) {
        data = { storyPoints: value };
      } else {
        return { ok: false, status: 400, error: "storyPoints must be a number or null" };
      }
      break;
    }
    case "dueDate": {
      if (value === null) {
        data = { dueDate: null };
      } else if (typeof value === "string") {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
          return { ok: false, status: 400, error: "Invalid dueDate" };
        }
        data = { dueDate: date };
      } else {
        return { ok: false, status: 400, error: "dueDate must be a date string or null" };
      }
      break;
    }
    case "iteration": {
      if (value !== null && typeof value !== "string") {
        return { ok: false, status: 400, error: "iteration must be text" };
      }
      const trimmed = typeof value === "string" ? value.trim() : "";
      data = { iteration: trimmed.length > 0 ? trimmed : null };
      break;
    }
    case "squadId": {
      if (value !== null && typeof value !== "string") {
        return { ok: false, status: 400, error: "squadId must be a string or null" };
      }
      data = { squadId: value };
      break;
    }
    default:
      return { ok: false, status: 400, error: `Field "${field}" is not editable` };
  }

  // DSQL has no @updatedAt trigger — every update must set it explicitly.
  data.updatedAt = new Date();

  const prisma = getPrisma();
  const exists = await prisma.task.findFirst({
    where: entityScopeWhere("task", id, workspaceId),
    select: { id: true },
  });
  if (!exists) return { ok: false, status: 404, error: "Not found" };

  await prisma.task.update({ where: { id }, data });
  return { ok: true };
}
