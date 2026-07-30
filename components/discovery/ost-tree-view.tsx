"use client";

import Link from "next/link";
import {
  TrendingUp,
  Lightbulb,
  Layers,
  AlertTriangle,
  FlaskConical,
  ChevronRight,
} from "lucide-react";
import type {
  OpportunityStatus,
  SolutionStatus,
  AssumptionStatus,
  RiskLevel,
  ExperimentStatus,
  Conclusion,
} from "@/lib/types";
import {
  OPPORTUNITY_STATUS_BADGE,
  SOLUTION_STATUS_BADGE,
  ASSUMPTION_STATUS_BADGE,
  RISK_LEVEL_BADGE,
  EXPERIMENT_STATUS_BADGE,
  CONCLUSION_BADGE,
} from "@/lib/discovery";

// ─── Data types ───────────────────────────────────────────────────────────────

export type OSTExperimentNode = {
  id: string;
  title: string;
  status: ExperimentStatus;
  conclusion: Conclusion | null;
  hypothesis: string;
};

export type OSTAssumptionNode = {
  id: string;
  title: string;
  riskLevel: RiskLevel;
  status: AssumptionStatus;
  experiments: OSTExperimentNode[];
};

export type OSTSolutionNode = {
  id: string;
  title: string;
  status: SolutionStatus;
  assumptions: OSTAssumptionNode[];
};

export type OSTOpportunityNode = {
  id: string;
  title: string;
  status: OpportunityStatus;
  linkedKeyResult: {
    id: string;
    title: string;
    objective: { title: string };
  } | null;
  solutions: OSTSolutionNode[];
};

type Props = {
  opportunity: OSTOpportunityNode;
  orgSlug: string;
  workspaceSlug: string;
};

// ─── Badge helper ─────────────────────────────────────────────────────────────

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${className}`}>
      {children}
    </span>
  );
}

// ─── Connector line wrapper ───────────────────────────────────────────────────
// Wraps children in an indented block with a vertical guideline.

function TreeBranch({ children, last = false }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`relative pl-6 ml-3 ${last ? "" : "border-l-2"} border-border/25`}>
      {children}
    </div>
  );
}

// A single node inside a branch — draws the horizontal ─ connector
function TreeNode({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative mt-2 first:mt-2">
      {/* Horizontal connector */}
      <div className="absolute left-[-24px] top-[14px] w-6 h-px bg-border/25" />
      {children}
    </div>
  );
}

// ─── Leaf node cards ─────────────────────────────────────────────────────────

function ExperimentCard({
  exp,
  href,
}: {
  exp: OSTExperimentNode;
  href: string;
}) {
  const s = EXPERIMENT_STATUS_BADGE[exp.status];
  const c = exp.conclusion ? CONCLUSION_BADGE[exp.conclusion] : null;

  return (
    <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2 flex items-start gap-2.5">
      <FlaskConical className="size-3.5 shrink-0 mt-0.5 text-emerald-600" />
      <div className="flex-1 min-w-0">
        <Link
          href={href}
          className="text-xs font-medium text-slate-800 hover:text-emerald-700 hover:underline leading-snug line-clamp-2"
        >
          {exp.title}
        </Link>
        <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1 italic">
          {exp.hypothesis}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Badge className={s.className}>{s.label}</Badge>
        {c && <Badge className={c.className}>{c.label}</Badge>}
      </div>
    </div>
  );
}

function AssumptionCard({
  assumption,
  orgSlug,
  workspaceSlug,
}: {
  assumption: OSTAssumptionNode;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const s = ASSUMPTION_STATUS_BADGE[assumption.status];
  const r = RISK_LEVEL_BADGE[assumption.riskLevel];
  const hasExperiments = assumption.experiments.length > 0;

  return (
    <div>
      <div className="rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2 flex items-start gap-2.5">
        <AlertTriangle className={`size-3.5 shrink-0 mt-0.5 ${r.className}`} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-slate-800 leading-snug">{assumption.title}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Badge className={`${r.className} bg-transparent border border-current/20`}>{assumption.riskLevel.toLowerCase()}</Badge>
          <Badge className={s.className}>{s.label}</Badge>
        </div>
      </div>

      {hasExperiments && (
        <TreeBranch>
          {assumption.experiments.map((exp) => (
            <TreeNode key={exp.id}>
              <ExperimentCard
                exp={exp}
                href={`/${orgSlug}/${workspaceSlug}/experiments/${exp.id}`}
              />
            </TreeNode>
          ))}
        </TreeBranch>
      )}

      {!hasExperiments && (
        <div className="ml-6 mt-1.5 pl-3 border-l-2 border-border/20 flex items-center gap-2 py-1">
          <p className="text-[10px] text-muted-foreground/50 italic">No experiments yet</p>
          <Link
            href={`/${orgSlug}/${workspaceSlug}/experiments?assumptionId=${assumption.id}`}
            className="text-[10px] font-medium text-emerald-600 hover:text-emerald-700 hover:underline whitespace-nowrap"
          >
            Test this assumption →
          </Link>
        </div>
      )}
    </div>
  );
}

function SolutionCard({
  solution,
  orgSlug,
  workspaceSlug,
}: {
  solution: OSTSolutionNode;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const s = SOLUTION_STATUS_BADGE[solution.status];
  const hasAssumptions = solution.assumptions.length > 0;

  return (
    <div>
      <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2 flex items-center gap-2.5">
        <Layers className="size-3.5 shrink-0 text-blue-500" />
        <p className="flex-1 text-xs font-medium text-slate-800 leading-snug">{solution.title}</p>
        <Badge className={`${s.className} shrink-0`}>{s.label}</Badge>
      </div>

      {hasAssumptions && (
        <TreeBranch>
          {solution.assumptions.map((assumption) => (
            <TreeNode key={assumption.id}>
              <AssumptionCard
                assumption={assumption}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
              />
            </TreeNode>
          ))}
        </TreeBranch>
      )}

      {!hasAssumptions && (
        <div className="ml-6 mt-1.5 pl-3 border-l-2 border-border/20">
          <p className="text-[10px] text-muted-foreground/50 italic py-1">No assumptions yet</p>
        </div>
      )}
    </div>
  );
}

// ─── Root tree component ──────────────────────────────────────────────────────

export function OSTTreeView({ opportunity, orgSlug, workspaceSlug }: Props) {
  const oppStatus = OPPORTUNITY_STATUS_BADGE[opportunity.status];
  const hasSolutions = opportunity.solutions.length > 0;

  return (
    <div className="flex flex-col gap-0 select-none">
      {/* Legend */}
      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mr-1">Legend</p>
        {[
          { Icon: TrendingUp,    cls: "text-indigo-500",  label: "Outcome" },
          { Icon: Lightbulb,     cls: "text-violet-500",  label: "Opportunity" },
          { Icon: Layers,        cls: "text-blue-500",    label: "Solution" },
          { Icon: AlertTriangle, cls: "text-amber-500",   label: "Assumption" },
          { Icon: FlaskConical,  cls: "text-emerald-500", label: "Experiment" },
        ].map(({ Icon, cls, label }) => (
          <div key={label} className="flex items-center gap-1">
            <Icon className={`size-3.5 ${cls}`} />
            <span className="text-xs text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>

      {/* KR / Outcome node */}
      {opportunity.linkedKeyResult && (
        <>
          <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 flex items-center gap-2.5 w-fit max-w-sm">
            <TrendingUp className="size-3.5 shrink-0 text-indigo-500" />
            <div className="min-w-0">
              <p className="text-[10px] text-indigo-400 leading-none mb-0.5">
                {opportunity.linkedKeyResult.objective.title}
              </p>
              <p className="text-xs font-medium text-indigo-800 leading-snug">
                {opportunity.linkedKeyResult.title}
              </p>
            </div>
          </div>

          <TreeBranch>
            {/* Opportunity node */}
            <TreeNode>
              <OppAndSolutions
                opportunity={opportunity}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                oppStatus={oppStatus}
                hasSolutions={hasSolutions}
              />
            </TreeNode>
          </TreeBranch>
        </>
      )}

      {/* No KR — opportunity is the root */}
      {!opportunity.linkedKeyResult && (
        <OppAndSolutions
          opportunity={opportunity}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          oppStatus={oppStatus}
          hasSolutions={hasSolutions}
        />
      )}
    </div>
  );
}

function OppAndSolutions({
  opportunity,
  orgSlug,
  workspaceSlug,
  oppStatus,
  hasSolutions,
}: {
  opportunity: OSTOpportunityNode;
  orgSlug: string;
  workspaceSlug: string;
  oppStatus: { label: string; className: string };
  hasSolutions: boolean;
}) {
  return (
    <div>
      {/* Opportunity node */}
      <div className="rounded-lg border border-violet-200 bg-violet-50/70 px-3 py-2.5 flex items-center gap-2.5">
        <Lightbulb className="size-3.5 shrink-0 text-violet-500" />
        <p className="flex-1 text-sm font-semibold text-violet-900 leading-snug">
          {opportunity.title}
        </p>
        <Badge className={`${oppStatus.className} shrink-0`}>{oppStatus.label}</Badge>
      </div>

      {hasSolutions ? (
        <TreeBranch>
          {opportunity.solutions.map((solution) => (
            <TreeNode key={solution.id}>
              <SolutionCard
                solution={solution}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
              />
            </TreeNode>
          ))}
        </TreeBranch>
      ) : (
        <div className="ml-6 mt-2 pl-3 border-l-2 border-border/20">
          <p className="text-xs text-muted-foreground/50 italic py-1">No solutions yet</p>
        </div>
      )}
    </div>
  );
}
