/**
 * Shared, framework-free Discovery/OST + Roadmap badge styling.
 *
 * Extracted from components/discovery/ost-tree-view.tsx's local, unexported
 * consts so the Canvas viewer's node components (components/canvas/*.tsx)
 * can render identical status colors/labels without duplicating them.
 * Naming matches lib/okrs.ts's convention (`cls` -> `className`). Pure — no
 * Prisma, no React — trivial to unit test if ever needed.
 */
import type {
  OpportunityStatus,
  SolutionStatus,
  AssumptionStatus,
  RiskLevel,
  ExperimentStatus,
  Conclusion,
  Horizon,
} from "@/lib/types";

export const OPPORTUNITY_STATUS_BADGE: Record<
  OpportunityStatus,
  { label: string; className: string }
> = {
  EXPLORING: { label: "Exploring", className: "bg-violet-100 text-violet-700" },
  VALIDATING: { label: "Validating", className: "bg-amber-100 text-amber-700" },
  PRIORITIZED: { label: "Prioritized", className: "bg-blue-100 text-blue-700" },
  ACTIVE: { label: "Active", className: "bg-green-100 text-green-700" },
  ARCHIVED: { label: "Archived", className: "bg-slate-100 text-slate-400" },
};

export const SOLUTION_STATUS_BADGE: Record<
  SolutionStatus,
  { label: string; className: string }
> = {
  IDEA: { label: "Idea", className: "bg-slate-100 text-slate-600" },
  VALIDATED: { label: "Validated", className: "bg-green-100 text-green-700" },
  IN_DELIVERY: { label: "In Delivery", className: "bg-blue-100 text-blue-700" },
  SHIPPED: { label: "Shipped", className: "bg-purple-100 text-purple-700" },
  KILLED: { label: "Killed", className: "bg-red-100 text-red-500" },
};

export const ASSUMPTION_STATUS_BADGE: Record<
  AssumptionStatus,
  { label: string; className: string }
> = {
  UNTESTED: { label: "Untested", className: "bg-slate-100 text-slate-500" },
  TESTING: { label: "Testing", className: "bg-amber-100 text-amber-700" },
  VALIDATED: { label: "Validated", className: "bg-green-100 text-green-700" },
  INVALIDATED: { label: "Invalidated", className: "bg-red-100 text-red-500" },
};

export const RISK_LEVEL_BADGE: Record<RiskLevel, { className: string }> = {
  HIGH: { className: "text-red-500" },
  MEDIUM: { className: "text-amber-500" },
  LOW: { className: "text-green-500" },
};

export const EXPERIMENT_STATUS_BADGE: Record<
  ExperimentStatus,
  { label: string; className: string }
> = {
  DESIGNING: { label: "Designing", className: "bg-slate-100 text-slate-600" },
  RUNNING: { label: "Running", className: "bg-blue-100 text-blue-700" },
  COMPLETE: { label: "Complete", className: "bg-emerald-100 text-emerald-700" },
  KILLED: { label: "Killed", className: "bg-red-100 text-red-500" },
  // Deliberately not run — kept visually distinct (neutral slate) from both
  // KILLED (red, evidence-based failure) and COMPLETE (green) so it can never
  // be mistaken for a tested-and-failed experiment.
  NOT_PURSUED: { label: "Not Pursued", className: "bg-slate-100 text-slate-500" },
};

export const CONCLUSION_BADGE: Record<
  Conclusion,
  { label: string; className: string }
> = {
  PROCEED: { label: "Proceed", className: "bg-green-100 text-green-700" },
  KILL: { label: "Kill", className: "bg-red-100 text-red-500" },
  ITERATE: { label: "Iterate", className: "bg-amber-100 text-amber-700" },
  NOT_PURSUED: { label: "Not Pursued", className: "bg-slate-100 text-slate-500" },
};

/** Ported from components/roadmap/roadmap-column.tsx's HORIZON_CONFIG — that
 * copy's field is named `accentClass`, normalized to `className` here to
 * match every other badge map in this file. */
export const HORIZON_BADGE: Record<Horizon, { label: string; className: string }> = {
  NOW: { label: "Now", className: "bg-emerald-500" },
  NEXT: { label: "Next", className: "bg-blue-500" },
  LATER: { label: "Later", className: "bg-slate-400" },
  LAUNCHING: { label: "Launching", className: "bg-amber-500" },
  LAUNCHED: { label: "Launched", className: "bg-teal-500" },
  SHIPPED: { label: "Shipped", className: "bg-purple-500" },
};
