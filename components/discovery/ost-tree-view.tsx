"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { ostLegendRootLabel } from "@/lib/thinking-model/copy";
import { useLabels, useThinkingModel } from "@/components/thinking-model/thinking-model-provider";
import { usePanelContext, type EntityPanelType } from "@/components/panels/panel-context";
import { experimentComposerId } from "@/lib/experiment-draft";
import {
  buildOpportunityChain,
  type ChainKeyResultNode,
  type ChainKrChip,
  type ChainLegendKind,
  type ChainMetric,
  type ChainParent,
  type ChainRoadmapItem,
  type ChainSolution,
  type ChainTasks,
  type OSTAssumptionNode,
  type OSTExperimentNode,
  type OSTOpportunityNode,
} from "@/lib/thinking-model/opportunity-chain";
import {
  TrendingUp,
  Lightbulb,
  Layers,
  AlertTriangle,
  FlaskConical,
  Target,
  Milestone,
  ListChecks,
  type LucideIcon,
} from "lucide-react";
import {
  OPPORTUNITY_STATUS_BADGE,
  SOLUTION_STATUS_BADGE,
  ASSUMPTION_STATUS_BADGE,
  RISK_LEVEL_BADGE,
  EXPERIMENT_STATUS_BADGE,
  CONCLUSION_BADGE,
} from "@/lib/discovery";
import { TASK_STATUS_LABELS } from "@/lib/task-meta";
import type { TaskStatus } from "@/lib/types";

// The data types live with the pure derivation (lib/thinking-model/opportunity-chain.ts); re-exported for callers.
export type { OSTAssumptionNode, OSTExperimentNode, OSTOpportunityNode, OSTSolutionNode } from "@/lib/thinking-model/opportunity-chain";

type Props = {
  opportunity: OSTOpportunityNode;
  orgSlug: string;
  workspaceSlug: string;
};

type OpenEntity = (type: EntityPanelType, id: string) => void;

// ─── Small parts ──────────────────────────────────────────────────────────────

function Badge({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${className}`}>
      {children}
    </span>
  );
}

/** A node card that opens the entity's panel when it has an id to open, and is a plain block otherwise. */
function NodeCard({
  className,
  onOpen,
  children,
}: {
  className: string;
  onOpen?: () => void;
  children: ReactNode;
}) {
  if (!onOpen) return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`${className} w-full text-left transition-colors hover:brightness-[0.98] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring`}
    >
      {children}
    </button>
  );
}

// ─── Connector line wrapper ───────────────────────────────────────────────────
// Wraps children in an indented block with a vertical guideline.

function TreeBranch({ children, last = false }: { children: ReactNode; last?: boolean }) {
  return (
    <div className={`relative pl-6 ml-3 ${last ? "" : "border-l-2"} border-border/25`}>
      {children}
    </div>
  );
}

// A single node inside a branch — draws the horizontal ─ connector
function TreeNode({ children }: { children: ReactNode }) {
  return (
    <div className="relative mt-2 first:mt-2">
      {/* Horizontal connector */}
      <div className="absolute left-[-24px] top-[14px] w-6 h-px bg-border/25" />
      {children}
    </div>
  );
}

function Empty({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`ml-6 mt-1.5 pl-3 border-l-2 border-border/20 ${className}`}>
      <p className="text-[10px] text-muted-foreground/50 italic py-1">{children}</p>
    </div>
  );
}

// ─── Parent nodes (Objective / Key Result) ───────────────────────────────────

function KeyResultRoot({ parent, open }: { parent: Extract<ChainParent, { kind: "keyResult" }>; open: OpenEntity }) {
  return (
    <NodeCard
      className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 flex items-center gap-2.5 w-fit max-w-sm"
      onOpen={() => open("keyResult", parent.id)}
    >
      <TrendingUp className="size-3.5 shrink-0 text-primary" />
      <div className="min-w-0">
        <p className="text-[10px] text-text-subtle leading-none mb-0.5 break-words">{parent.objective.title}</p>
        <p className="text-xs font-medium text-text-primary leading-snug break-words">{parent.title}</p>
      </div>
    </NodeCard>
  );
}

function KeyResultNode({ kr, open }: { kr: ChainKeyResultNode; open: OpenEntity }) {
  const secondary = kr.emphasis === "secondary";
  return (
    <NodeCard
      className={`rounded-lg border px-3 py-1.5 flex items-center gap-2.5 w-fit max-w-full ${
        secondary ? "border-dashed border-primary/20 bg-primary/5" : "border-primary/20 bg-primary/10"
      }`}
      onOpen={() => open("keyResult", kr.id)}
    >
      <TrendingUp className="size-3.5 shrink-0 text-primary" />
      <p className="text-xs font-medium text-text-primary leading-snug break-words min-w-0">{kr.title}</p>
    </NodeCard>
  );
}

function MetricStrip({ metrics, open }: { metrics: ChainMetric[]; open: OpenEntity }) {
  const labels = useLabels();
  if (metrics.length === 0) return null;
  return (
    <div data-testid="ost-metrics" className="ml-3 mt-1.5 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{labels.keyResult.plural}</span>
      <ul aria-label={labels.keyResult.plural} className="flex flex-wrap items-center gap-1.5">
        {metrics.map((metric) => (
          <li key={metric.id} className="max-w-full">
            <button
              type="button"
              onClick={() => open("keyResult", metric.id)}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-left text-[11px] text-text-primary hover:bg-primary/15"
            >
              <TrendingUp aria-hidden className="size-3 shrink-0 text-primary" />
              <span className="break-words">{metric.title}</span>
              {metric.progress !== null && <span className="shrink-0 tabular-nums text-primary">{Math.round(metric.progress * 100)}%</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ObjectiveNode({ parent, open }: { parent: Extract<ChainParent, { kind: "objective" }>; open: OpenEntity }) {
  const labels = useLabels();
  const id = parent.id;
  return (
    <div>
      <NodeCard
        className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 flex items-center gap-2.5 w-fit max-w-full"
        onOpen={id ? () => open("objective", id) : undefined}
      >
        <Target className="size-3.5 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="text-[10px] text-text-subtle leading-none mb-0.5">{labels.objective.singular}</p>
          <p className="text-xs font-medium text-text-primary leading-snug break-words">{parent.title}</p>
        </div>
      </NodeCard>
      {parent.keyResults.length > 0 && (
        <TreeBranch last>
          {parent.keyResults.map((kr) => (
            <TreeNode key={kr.id}>
              <KeyResultNode kr={kr} open={open} />
            </TreeNode>
          ))}
        </TreeBranch>
      )}
      <MetricStrip metrics={parent.metrics} open={open} />
    </div>
  );
}

function Parents({ parents, open }: { parents: ChainParent[]; open: OpenEntity }) {
  const labels = useLabels();
  const objectiveParents = parents.filter((parent) => parent.kind === "objective");
  return (
    <div data-testid="ost-parents" className="flex flex-col gap-2">
      {objectiveParents.length > 1 && (
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{`Linked ${labels.objective.lowerPlural}`}</p>
      )}
      {parents.map((parent) =>
        parent.kind === "keyResult" ? (
          <KeyResultRoot key={`kr-${parent.id}`} parent={parent} open={open} />
        ) : (
          <ObjectiveNode key={`objective-${parent.id ?? parent.title}`} parent={parent} open={open} />
        ),
      )}
    </div>
  );
}

// ─── Delivery leaves (roadmap items, tasks) ──────────────────────────────────

function RoadmapItemRow({ item, open }: { item: ChainRoadmapItem; open: OpenEntity }) {
  return (
    <NodeCard
      className="rounded-lg border border-border/40 bg-surface-inset/50 px-3 py-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1"
      onOpen={() => open("roadmapItem", item.id)}
    >
      <Milestone className="size-3.5 shrink-0 text-text-secondary" />
      <p className="min-w-[8rem] flex-1 text-xs font-medium text-text-primary leading-snug break-words">{item.title}</p>
      <Badge className="bg-surface-inset text-text-secondary">{horizonLabel(item.horizon)}</Badge>
    </NodeCard>
  );
}

const horizonLabel = (horizon: string) => horizon.charAt(0) + horizon.slice(1).toLowerCase();

function TaskRows({ tasks, open }: { tasks: ChainTasks; open: OpenEntity }) {
  return (
    <>
      {tasks.items.map((task) => (
        <TreeNode key={task.id}>
          <NodeCard
            className="rounded-lg border border-border/40 bg-surface-inset/50 px-3 py-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1"
            onOpen={() => open("task", task.id)}
          >
            <ListChecks className="size-3.5 shrink-0 text-text-subtle" />
            <p className="min-w-[8rem] flex-1 text-xs text-text-primary leading-snug break-words">{task.title}</p>
            <Badge className="bg-surface-inset text-text-secondary">{TASK_STATUS_LABELS[task.status as TaskStatus] ?? task.status}</Badge>
          </NodeCard>
        </TreeNode>
      ))}
      {tasks.more > 0 && (
        <TreeNode>
          <p className="py-1 text-[10px] text-muted-foreground">{`+${tasks.more} more`}</p>
        </TreeNode>
      )}
    </>
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
    <div className="rounded-lg border border-status-success/20 bg-status-success-surface px-3 py-2 flex flex-wrap items-start gap-x-2.5 gap-y-1">
      <FlaskConical className="size-3.5 shrink-0 mt-0.5 text-emerald-600" />
      <div className="flex-1 min-w-[8rem]">
        <Link
          href={href}
          className="text-xs font-medium text-text-primary hover:text-emerald-700 hover:underline leading-snug line-clamp-2"
        >
          {exp.title}
        </Link>
        <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1 italic">
          {exp.hypothesis}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
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
  open,
}: {
  assumption: OSTAssumptionNode;
  orgSlug: string;
  workspaceSlug: string;
  open: OpenEntity;
}) {
  const s = ASSUMPTION_STATUS_BADGE[assumption.status];
  const r = RISK_LEVEL_BADGE[assumption.riskLevel];
  const hasExperiments = assumption.experiments.length > 0;

  return (
    <div>
      <NodeCard
        className="rounded-lg border border-status-warning/20 bg-status-warning-surface px-3 py-2 flex flex-wrap items-start gap-x-2.5 gap-y-1"
        onOpen={() => open("assumption", assumption.id)}
      >
        <AlertTriangle className={`size-3.5 shrink-0 mt-0.5 ${r.className}`} />
        <div className="flex-1 min-w-[8rem]">
          <p className="text-xs font-medium text-text-primary leading-snug break-words">{assumption.title}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Badge className={`${r.className} bg-transparent border border-current/20`}>{assumption.riskLevel.toLowerCase()}</Badge>
          <Badge className={s.className}>{s.label}</Badge>
        </div>
      </NodeCard>

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
        <div className="ml-6 mt-1.5 pl-3 border-l-2 border-border/20 flex flex-wrap items-center gap-x-2 py-1">
          <p className="text-[10px] text-muted-foreground/50 italic">No experiments yet</p>
          <Link
            href={`/${orgSlug}/${workspaceSlug}/experiments?detail=experiment-new:${experimentComposerId(assumption.id)}`}
            className="text-[10px] font-medium text-emerald-600 hover:text-emerald-700 hover:underline whitespace-nowrap"
          >
            Test this assumption →
          </Link>
        </div>
      )}
    </div>
  );
}

function KrChipList({ chips, open }: { chips: ChainKrChip[]; open: OpenEntity }) {
  const labels = useLabels();
  if (chips.length === 0) return null;
  return (
    <ul aria-label={`Targeted ${labels.keyResult.lowerPlural}`} data-testid="ost-kr-chips" className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <li key={chip.id} className="max-w-full">
          <button
            type="button"
            onClick={() => open("keyResult", chip.id)}
            title={chip.crossOutcome && chip.objectiveTitle ? `${labels.objective.singular}: ${chip.objectiveTitle}` : undefined}
            className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-left text-[11px] text-text-primary hover:bg-primary/15 ${
              chip.crossOutcome ? "border-dashed border-primary/40 bg-transparent" : "border-primary/20 bg-primary/10"
            }`}
          >
            <TrendingUp aria-hidden className="size-3 shrink-0 text-primary" />
            <span className="break-words">{chip.title}</span>
            {chip.crossOutcome && chip.objectiveTitle && <span className="break-words text-text-subtle">{`· ${chip.objectiveTitle}`}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function SolutionCard({
  solution,
  orgSlug,
  workspaceSlug,
  open,
}: {
  solution: ChainSolution;
  orgSlug: string;
  workspaceSlug: string;
  open: OpenEntity;
}) {
  const s = SOLUTION_STATUS_BADGE[solution.status];
  const hasAssumptions = solution.assumptions.length > 0;
  const hasDelivery = solution.roadmapItems.length > 0 || solution.tasks.items.length > 0;

  return (
    <div>
      <NodeCard
        className="rounded-lg border border-status-info/20 bg-status-info-surface px-3 py-2 flex flex-wrap items-center gap-x-2.5 gap-y-1"
        onOpen={() => open("solution", solution.id)}
      >
        <Layers className="size-3.5 shrink-0 text-blue-500" />
        <p className="flex-1 min-w-[8rem] text-xs font-medium text-text-primary leading-snug break-words">{solution.title}</p>
        <Badge className={`${s.className} shrink-0`}>{s.label}</Badge>
      </NodeCard>
      <KrChipList chips={solution.krChips} open={open} />

      {(hasAssumptions || hasDelivery) && (
        <TreeBranch>
          {solution.assumptions.map((assumption) => (
            <TreeNode key={assumption.id}>
              <AssumptionCard assumption={assumption} orgSlug={orgSlug} workspaceSlug={workspaceSlug} open={open} />
            </TreeNode>
          ))}
          {solution.roadmapItems.map((item) => (
            <TreeNode key={item.id}>
              <RoadmapItemRow item={item} open={open} />
            </TreeNode>
          ))}
          <TaskRows tasks={solution.tasks} open={open} />
        </TreeBranch>
      )}

      {!hasAssumptions && <Empty>No assumptions yet</Empty>}
    </div>
  );
}

// ─── Legend ──────────────────────────────────────────────────────────────────

const LEGEND_ICON: Record<ChainLegendKind, { Icon: LucideIcon; cls: string }> = {
  root: { Icon: TrendingUp, cls: "text-primary" },
  objective: { Icon: Target, cls: "text-primary" },
  keyResult: { Icon: TrendingUp, cls: "text-primary" },
  opportunity: { Icon: Lightbulb, cls: "text-violet-500" },
  solution: { Icon: Layers, cls: "text-blue-500" },
  assumption: { Icon: AlertTriangle, cls: "text-amber-500" },
  experiment: { Icon: FlaskConical, cls: "text-emerald-500" },
  roadmapItem: { Icon: Milestone, cls: "text-text-secondary" },
  task: { Icon: ListChecks, cls: "text-text-subtle" },
};

// ─── Root tree component ──────────────────────────────────────────────────────

export function OSTTreeView({ opportunity, orgSlug, workspaceSlug }: Props) {
  const labels = useLabels();
  const model = useThinkingModel();
  const { openPanel } = usePanelContext();
  const chain = useMemo(() => buildOpportunityChain(opportunity, { links: model.links, tree: model.tree }), [opportunity, model.links, model.tree]);
  const oppStatus = OPPORTUNITY_STATUS_BADGE[chain.opportunity.status];

  const legendLabel: Record<ChainLegendKind, string> = {
    root: ostLegendRootLabel(labels),
    objective: labels.objective.singular,
    keyResult: labels.keyResult.singular,
    opportunity: labels.opportunity.singular,
    solution: labels.solution.singular,
    assumption: "Assumption",
    experiment: "Experiment",
    roadmapItem: "Roadmap item",
    task: "Task",
  };

  const opportunityNode = (
    <OppAndSolutions chain={chain.opportunity} orgSlug={orgSlug} workspaceSlug={workspaceSlug} oppStatus={oppStatus} open={openPanel} />
  );

  return (
    // min-w keeps the tree readable at panel widths: the tab's container scrolls horizontally instead of squashing.
    <div className="flex min-w-[21rem] flex-col gap-0 select-none">
      {/* Legend */}
      <div className="flex items-center gap-x-4 gap-y-1 mb-4 flex-wrap">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mr-1">Legend</p>
        {chain.legend.map((kind) => {
          const { Icon, cls } = LEGEND_ICON[kind];
          return (
            <div key={kind} className="flex items-center gap-1">
              <Icon className={`size-3.5 ${cls}`} />
              <span className="text-xs text-muted-foreground">{legendLabel[kind]}</span>
            </div>
          );
        })}
      </div>

      {chain.parents.length > 0 ? (
        <>
          <Parents parents={chain.parents} open={openPanel} />
          <TreeBranch>
            <TreeNode>{opportunityNode}</TreeNode>
          </TreeBranch>
        </>
      ) : (
        // No parent drawn: the opportunity is the root.
        opportunityNode
      )}
    </div>
  );
}

function OppAndSolutions({
  chain,
  orgSlug,
  workspaceSlug,
  oppStatus,
  open,
}: {
  chain: ReturnType<typeof buildOpportunityChain>["opportunity"];
  orgSlug: string;
  workspaceSlug: string;
  oppStatus: { label: string; className: string };
  open: OpenEntity;
}) {
  const labels = useLabels();
  const hasSolutions = chain.solutions.length > 0;
  const hasDelivery = chain.roadmapItems.length > 0 || chain.tasks.items.length > 0;
  return (
    <div>
      {/* Opportunity node */}
      <div className="rounded-lg border border-violet-200 bg-violet-50/70 px-3 py-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Lightbulb className="size-3.5 shrink-0 text-violet-500" />
        <p className="flex-1 min-w-[8rem] text-sm font-semibold text-violet-900 leading-snug break-words">
          {chain.title}
        </p>
        <Badge className={`${oppStatus.className} shrink-0`}>{oppStatus.label}</Badge>
      </div>

      {(hasSolutions || hasDelivery) && (
        <TreeBranch>
          {chain.solutions.map((solution) => (
            <TreeNode key={solution.id}>
              <SolutionCard solution={solution} orgSlug={orgSlug} workspaceSlug={workspaceSlug} open={open} />
            </TreeNode>
          ))}
          {chain.roadmapItems.map((item) => (
            <TreeNode key={item.id}>
              <RoadmapItemRow item={item} open={open} />
            </TreeNode>
          ))}
          <TaskRows tasks={chain.tasks} open={open} />
        </TreeBranch>
      )}

      {!hasSolutions && (
        <div className="ml-6 mt-2 pl-3 border-l-2 border-border/20">
          <p className="text-xs text-muted-foreground/50 italic py-1">{`No ${labels.solution.lowerPlural} yet`}</p>
        </div>
      )}
    </div>
  );
}
