import { cn } from "@/lib/utils";

// ── Mini mocks ────────────────────────────────────────────────────────────────

function OkrTraceMock() {
  return (
    <div className="bg-slate-50 rounded-lg p-3 text-xs font-mono space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-indigo-600 font-bold">OKR</span>
        <span className="text-slate-400">Grow activation</span>
      </div>
      <div className="flex items-center gap-2 pl-4">
        <span className="border-l-2 border-indigo-200 pl-2 text-indigo-500 font-bold">KR</span>
        <span className="text-slate-400">Time-to-first-OST &lt; 8 min</span>
      </div>
      <div className="flex items-center gap-2 pl-8">
        <span className="border-l-2 border-indigo-200 pl-2 text-slate-500">
          3 opportunities linked
        </span>
      </div>
      <div className="flex items-center gap-2 pl-8">
        <div className="border-l-2 border-indigo-200 pl-2 flex gap-1">
          <span className="bg-indigo-100 text-indigo-600 px-1 rounded">→ opp</span>
          <span className="bg-indigo-100 text-indigo-600 px-1 rounded">→ opp</span>
          <span className="bg-indigo-100 text-indigo-600 px-1 rounded">→ opp</span>
        </div>
      </div>
    </div>
  );
}

function OstNativeMock() {
  return (
    <div className="bg-slate-50 rounded-lg p-3 text-xs space-y-1.5">
      <div className="bg-white border border-slate-200 rounded-lg p-2.5">
        <p className="font-semibold text-slate-700 text-[11px]">
          Synthesis not connected to next decision
        </p>
        <div className="mt-2 space-y-1">
          {["Landing page flow", "AI synthesis summary", "Quick-add from interview"].map((s) => (
            <div
              key={s}
              className="flex items-center gap-2 text-[10px] text-slate-500 pl-2 border-l-2 border-indigo-200"
            >
              <span className="text-indigo-400">↳</span>
              <span>{s}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 text-[10px] text-indigo-500 font-medium">
          + 3 solutions ›
        </div>
      </div>
    </div>
  );
}

function ExperimentMock() {
  return (
    <div className="bg-slate-50 rounded-lg p-3 text-xs space-y-2">
      <div className="flex justify-between text-[11px]">
        <span className="font-semibold text-slate-700">Experiment brief</span>
        <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-[9px] font-bold">
          RUNNING
        </span>
      </div>
      <div>
        <p className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold">
          Hypothesis
        </p>
        <p className="text-[11px] text-slate-600 mt-0.5">
          Adding a setup wizard will reduce time-to-first-OST by 40%.
        </p>
      </div>
      <div>
        <div className="flex justify-between text-[10px] text-slate-500 mb-1">
          <span>Progress</span>
          <span>50%</span>
        </div>
        <div className="w-full h-1.5 bg-slate-200 rounded-full">
          <div className="h-1.5 bg-indigo-500 rounded-full w-1/2" />
        </div>
      </div>
      <div>
        <p className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold">
          Kill condition
        </p>
        <p className="text-[11px] text-slate-600 mt-0.5">&lt; 10% improvement after 7 days</p>
      </div>
    </div>
  );
}

function RoadmapMock() {
  const cols = [
    { label: "NOW", color: "bg-indigo-500" },
    { label: "NEXT", color: "bg-indigo-300" },
    { label: "LATER", color: "bg-slate-300" },
  ];
  return (
    <div className="bg-slate-50 rounded-lg p-3 text-xs">
      <div className="grid grid-cols-3 gap-2">
        {cols.map((col) => (
          <div key={col.label} className="space-y-2">
            <p className="text-[10px] font-bold text-slate-500 tracking-wide">
              {col.label}
            </p>
            <div className="flex items-center gap-1.5">
              <span className={cn("w-2.5 h-2.5 rounded-full flex-shrink-0", col.color)} />
              <span className="bg-indigo-50 text-indigo-600 text-[9px] px-1 rounded font-medium">
                → OKR
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={cn("w-2.5 h-2.5 rounded-full flex-shrink-0", col.color)} />
              <span className="bg-indigo-50 text-indigo-600 text-[9px] px-1 rounded font-medium">
                → OKR
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function McpMock() {
  return (
    <div className="bg-slate-900 rounded-lg p-3 text-xs font-mono space-y-1.5">
      <p className="text-slate-500 text-[10px]">$ compass mcp</p>
      <p className="text-green-400">
        <span className="text-indigo-400">compass</span>
        <span className="text-slate-400">:</span>
        <span className="text-yellow-300">list_opportunities</span>
      </p>
      <p className="text-slate-400 text-[10px]">→ 4 results</p>
      <span className="inline-block w-1.5 h-3.5 bg-slate-400 animate-pulse align-middle" />
    </div>
  );
}

function PortalMock() {
  return (
    <div className="bg-slate-50 rounded-lg overflow-hidden border border-slate-200 text-xs">
      <div className="bg-white border-b border-slate-200 px-3 py-2 flex items-center gap-2">
        <div className="flex gap-1">
          <span className="w-2 h-2 rounded-full bg-red-400/70" />
          <span className="w-2 h-2 rounded-full bg-yellow-400/70" />
          <span className="w-2 h-2 rounded-full bg-green-400/70" />
        </div>
        <span className="text-[10px] text-slate-400 font-mono truncate">
          roadmap.compass.rbcodelabs.com
        </span>
      </div>
      <div className="p-3 space-y-2">
        <p className="font-semibold text-slate-700 text-[11px]">Public Roadmap</p>
        {["OST share link", "Experiment briefs", "MCP API"].map((item) => (
          <div
            key={item}
            className="flex items-center justify-between bg-white border border-slate-200 rounded p-2"
          >
            <span className="text-slate-600 text-[10px]">{item}</span>
            <span className="bg-indigo-50 text-indigo-600 text-[9px] px-1.5 py-0.5 rounded font-bold">
              SHIPPED
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Feature cards data ────────────────────────────────────────────────────────

const FEATURES = [
  {
    mock: <OkrTraceMock />,
    title: "OKRs that trace to delivery",
    body: "Every roadmap item links back to the key result that justified it. No more guessing why something was built.",
  },
  {
    mock: <OstNativeMock />,
    title: "Opportunity Solution Trees, built in",
    body: "Opportunities, solutions, assumptions, and experiments are first-class objects — not just tags on a ticket.",
  },
  {
    mock: <ExperimentMock />,
    title: "Validate before you commit",
    body: "Design experiment briefs, track results, and only promote to the roadmap what's actually proven.",
  },
  {
    mock: <RoadmapMock />,
    title: "Roadmap with the why attached",
    body: "Each roadmap item shows the opportunity, the solution, and the experiment that validated it.",
  },
  {
    mock: <McpMock />,
    title: "Your AI works in Compass too",
    body: "The MCP API means Claude can read your product strategy, create opportunities from interviews, and update experiment results.",
  },
  {
    mock: <PortalMock />,
    title: "Public roadmap and feedback portals",
    body: "Share your roadmap publicly and collect customer feedback — no login required for your users.",
  },
];

// ── Section ───────────────────────────────────────────────────────────────────

export function FeaturesSection() {
  return (
    <section className="bg-white py-20 lg:py-24">
      <div className="max-w-6xl mx-auto px-6">
        <div className="text-center mb-14">
          <h2 className="text-3xl lg:text-4xl font-bold tracking-tight text-slate-900">
            Everything connected, nothing siloed
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col gap-4"
            >
              {/* Mini mock */}
              <div aria-hidden="true">{f.mock}</div>
              {/* Text */}
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold text-slate-900 text-base">
                  {f.title}
                </h3>
                <p className="text-sm text-slate-500 leading-relaxed">{f.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
