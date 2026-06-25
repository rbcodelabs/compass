import {
  Target,
  Lightbulb,
  Puzzle,
  HelpCircle,
  FlaskConical,
  Map,
} from "lucide-react";

const NODES = [
  {
    icon: Target,
    title: "OKR",
    subtitle: "Set outcomes first",
  },
  {
    icon: Lightbulb,
    title: "Opportunity",
    subtitle: "Surface what's blocking them",
  },
  {
    icon: Puzzle,
    title: "Solution",
    subtitle: "Design how to solve it",
  },
  {
    icon: HelpCircle,
    title: "Assumption",
    subtitle: "Name what must be true",
  },
  {
    icon: FlaskConical,
    title: "Experiment",
    subtitle: "Test before you build",
  },
  {
    icon: Map,
    title: "Roadmap",
    subtitle: "Ship what's validated",
  },
];

export function OstFlowSection() {
  return (
    <section className="bg-slate-50 py-20 lg:py-24">
      <div className="max-w-6xl mx-auto px-6">
        <div className="text-center mb-14">
          <h2 className="text-3xl lg:text-4xl font-bold tracking-tight text-slate-900">
            The full stack of continuous discovery
          </h2>
          <p className="mt-4 text-lg text-slate-500 max-w-2xl mx-auto">
            Every layer connects. Outcomes drive opportunities. Opportunities
            drive experiments. Experiments drive the roadmap.
          </p>
        </div>

        {/* Flow nodes */}
        <div className="flex flex-col lg:flex-row items-center gap-0">
          {NODES.map((node, i) => {
            const Icon = node.icon;
            return (
              <div key={node.title} className="flex flex-col lg:flex-row items-center w-full lg:w-auto">
                {/* Node card */}
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex flex-col items-center text-center gap-3 w-full lg:w-36">
                  <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                    <Icon className="w-5 h-5 text-indigo-600" />
                  </div>
                  <div>
                    <p className="font-semibold text-slate-900 text-sm">
                      {node.title}
                    </p>
                    <p className="text-xs text-slate-500 mt-1 leading-snug">
                      {node.subtitle}
                    </p>
                  </div>
                </div>

                {/* Connector arrow (not after last node) */}
                {i < NODES.length - 1 && (
                  <div className="flex items-center justify-center lg:w-8 lg:h-auto h-6 w-auto flex-shrink-0">
                    {/* Horizontal on lg, vertical on mobile */}
                    <span className="hidden lg:block text-indigo-300 text-lg font-bold">
                      →
                    </span>
                    <span className="lg:hidden text-indigo-300 text-lg font-bold rotate-90">
                      →
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
